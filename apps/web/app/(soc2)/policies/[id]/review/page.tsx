/**
 * /policies/[id]/review — the human review surface (F1-005).
 *
 * The mandatory human-approval gate the liability_assessor requires before
 * auditor submission. A split view: book-like policy prose with inline citation
 * markers on the LEFT; a sticky RIGHT rail listing each grounded claim with its
 * cited evidence artifact excerpt, a version diff against the prior draft, and
 * the approve / request-changes actions. A persistent note reminds the reviewer
 * that output requires legal sign-off.
 *
 * Server component; the only client interactivity is the two review forms, each
 * a Server Action that records a soc2_policy_reviews row and flips the version
 * status (approve -> 'approved', request-changes -> back to 'draft').
 */

import type { JSX } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { resolveScanAccess } from "@/lib/soc2/scan/access";
import {
  getPolicy,
  getPreviousVersion,
  listPolicyReviews,
  recordReview,
  submitForReview,
  type PolicyDetail,
  type PolicyReview,
} from "@/lib/soc2/policies/generate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LEGAL_NOTE =
  "Approval here records your organization's review. This is a drafting aid — final policy documents still require your legal team's sign-off before auditor submission. It is never an audit opinion.";

const STATUS_META: Record<string, { label: string; color: string }> = {
  draft: { label: "Draft", color: "#555" },
  in_review: { label: "In review", color: "#9a6a00" },
  approved: { label: "Approved", color: "#0a7d33" },
  stale: { label: "Stale", color: "#8a1c1c" },
};

function StatusPill({ status }: { status: string }): JSX.Element {
  const meta = STATUS_META[status] ?? { label: status, color: "#555" };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: "#fff",
        background: meta.color,
        whiteSpace: "nowrap",
      }}
    >
      {meta.label}
    </span>
  );
}

/** Render a markdown body as book-like prose (headings, lists, paragraphs). */
function renderProse(markdown: string): JSX.Element[] {
  const blocks = markdown.split(/\n{2,}/);
  const out: JSX.Element[] = [];
  blocks.forEach((block, i) => {
    const trimmed = block.trim();
    if (!trimmed) return;
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      out.push(<Tag key={`b${i}`}>{heading[2]}</Tag>);
      return;
    }
    const lines = trimmed.split(/\n/);
    const isList = lines.every((l) => /^\s*[-*]\s+/.test(l));
    if (isList) {
      out.push(
        <ul key={`b${i}`}>
          {lines.map((l, j) => (
            <li key={`b${i}-${j}`}>{l.replace(/^\s*[-*]\s+/, "")}</li>
          ))}
        </ul>,
      );
      return;
    }
    out.push(<p key={`b${i}`}>{trimmed}</p>);
  });
  return out;
}

/** Server Action: record an approval decision. */
async function approveAction(formData: FormData): Promise<void> {
  "use server";
  const access = await resolveScanAccess();
  if (!access) redirect("/connect");
  const policyId = String(formData.get("policy_id") ?? "");
  if (!policyId) redirect("/policies");
  const note = String(formData.get("note") ?? "").trim();
  await recordReview(access.organizationId, policyId, access.userId, "approved", note || "Approved.");
  redirect(`/policies/${policyId}/review`);
}

/** Server Action: send the draft back with requested changes. */
async function requestChangesAction(formData: FormData): Promise<void> {
  "use server";
  const access = await resolveScanAccess();
  if (!access) redirect("/connect");
  const policyId = String(formData.get("policy_id") ?? "");
  if (!policyId) redirect("/policies");
  const note = String(formData.get("note") ?? "").trim();
  await recordReview(
    access.organizationId,
    policyId,
    access.userId,
    "changes_requested",
    note || "Changes requested.",
  );
  redirect(`/policies/${policyId}/review`);
}

/** Server Action: move a draft into the in-review state. */
async function submitReviewAction(formData: FormData): Promise<void> {
  "use server";
  const access = await resolveScanAccess();
  if (!access) redirect("/connect");
  const policyId = String(formData.get("policy_id") ?? "");
  if (!policyId) redirect("/policies");
  await submitForReview(access.organizationId, policyId);
  redirect(`/policies/${policyId}/review`);
}

/** A compact, human-readable diff line set between two policy versions. */
function diffLines(current: PolicyDetail, previous: PolicyDetail | null): string[] {
  if (!previous) return ["First version — no prior draft to compare."];
  const lines: string[] = [`Comparing v${previous.versionNumber} → v${current.versionNumber}.`];
  if (previous.title !== current.title) lines.push("Title changed.");
  if (previous.summary !== current.summary) lines.push("Summary changed.");
  const claimDelta = current.claims.length - previous.claims.length;
  if (claimDelta !== 0) {
    lines.push(`${claimDelta > 0 ? "+" : ""}${claimDelta} grounded claim(s).`);
  }
  const prevArtifacts = new Set(previous.citedArtifactIds);
  const added = current.citedArtifactIds.filter((id) => !prevArtifacts.has(id)).length;
  const curArtifacts = new Set(current.citedArtifactIds);
  const removed = previous.citedArtifactIds.filter((id) => !curArtifacts.has(id)).length;
  if (added > 0) lines.push(`${added} new evidence citation(s).`);
  if (removed > 0) lines.push(`${removed} citation(s) dropped.`);
  if (previous.markdownBody.trim() === current.markdownBody.trim() && claimDelta === 0) {
    lines.push("Body text unchanged.");
  }
  return lines;
}

export default async function PolicyReviewPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const access = await resolveScanAccess();
  if (!access) {
    return (
      <main>
        <h1>Policy Review</h1>
        <p>Your session or workspace role has expired.</p>
        <Link className="btn" href="/connect">
          Re-verify access
        </Link>
      </main>
    );
  }

  const policy = await getPolicy(access.organizationId, params.id);
  if (!policy) {
    notFound();
  }

  const previous = await getPreviousVersion(
    access.organizationId,
    policy.policyType,
    policy.versionNumber,
  );
  const reviews: PolicyReview[] = await listPolicyReviews(access.organizationId, policy.id);

  const citationIndex = new Map<string, number>();
  policy.claims.forEach((c) => {
    if (!citationIndex.has(c.artifactId)) citationIndex.set(c.artifactId, citationIndex.size + 1);
  });
  const orderedArtifacts = [...citationIndex.entries()].sort((a, b) => a[1] - b[1]);

  return (
    <main style={{ maxWidth: 1180 }}>
      <p className="muted">
        <Link href="/policies">← All policies</Link>
      </p>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <h1 style={{ marginBottom: 4 }}>Review · {policy.title}</h1>
        <StatusPill status={policy.status} />
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        {policy.label} · Version {policy.versionNumber} · content hash {policy.contentHash.slice(0, 12)}
      </p>

      <div className="card" style={{ borderColor: "#9a6a00", background: "transparent" }}>
        <strong>Legal sign-off required.</strong>
        <p className="muted" style={{ margin: "6px 0 0" }}>
          {LEGAL_NOTE}
        </p>
      </div>

      <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* LEFT — book-like prose with inline citation markers */}
        <article className="card" style={{ flex: "1 1 520px", minWidth: 320, lineHeight: 1.7 }}>
          <p className="muted">{policy.summary}</p>
          {policy.markdownBody ? renderProse(policy.markdownBody) : <p className="muted">No body.</p>}

          <h3>Grounded claims</h3>
          <ol>
            {policy.claims.map((claim, i) => (
              <li key={`${claim.artifactId}-${i}`} style={{ marginBottom: 8 }}>
                {claim.statement}{" "}
                <sup style={{ color: "#3355cc", fontWeight: 600 }}>[{citationIndex.get(claim.artifactId)}]</sup>
              </li>
            ))}
          </ol>
        </article>

        {/* RIGHT — sticky citation + diff + actions rail */}
        <aside
          style={{
            flex: "1 1 320px",
            minWidth: 300,
            position: "sticky",
            top: 16,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Evidence citations</h3>
            {orderedArtifacts.length === 0 ? (
              <p className="muted">No claims cite evidence in this draft.</p>
            ) : (
              orderedArtifacts.map(([artifactId, index]) => {
                const artifact = policy.artifacts[artifactId];
                const excerpt = artifact ? JSON.stringify(artifact.excerpt ?? {}, null, 2) : "{}";
                return (
                  <div key={artifactId} style={{ marginBottom: 14 }}>
                    <div style={{ fontWeight: 600 }}>
                      <span style={{ color: "#3355cc" }}>[{index}]</span>{" "}
                      {artifact ? `${artifact.controlRef} · ${artifact.ruleTitle}` : "artifact"}
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {artifact ? `${artifact.provider}/${artifact.resourceType} · ${artifact.jsonPath}` : ""}
                      {artifact?.sha256 ? ` · sha256 ${artifact.sha256.slice(0, 10)}` : ""}
                    </div>
                    <pre
                      style={{
                        fontSize: 11,
                        maxHeight: 160,
                        overflow: "auto",
                        background: "rgba(127,127,127,0.08)",
                        padding: 8,
                        borderRadius: 6,
                        marginTop: 4,
                      }}
                    >
                      {excerpt}
                    </pre>
                  </div>
                );
              })
            )}
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Version diff</h3>
            <ul>
              {diffLines(policy, previous).map((line, i) => (
                <li key={`diff-${i}`} className="muted" style={{ fontSize: 13 }}>
                  {line}
                </li>
              ))}
            </ul>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Decision</h3>
            {policy.status === "approved" ? (
              <p className="muted">
                Approved{policy.approvedAt ? ` on ${policy.approvedAt.slice(0, 10)}` : ""}. Legal sign-off
                still required before auditor submission.
              </p>
            ) : null}
            {policy.status === "draft" ? (
              <form action={submitReviewAction} style={{ marginBottom: 12 }}>
                <input type="hidden" name="policy_id" value={policy.id} />
                <button type="submit" className="btn secondary">
                  Mark as in review
                </button>
              </form>
            ) : null}
            <form action={approveAction} style={{ marginBottom: 12 }}>
              <input type="hidden" name="policy_id" value={policy.id} />
              <label htmlFor="approve-note" className="muted" style={{ fontSize: 13 }}>
                Reviewer note (optional)
              </label>
              <input id="approve-note" type="text" name="note" placeholder="e.g. Reviewed against evidence" />
              <button type="submit">Approve</button>
            </form>
            <form action={requestChangesAction}>
              <input type="hidden" name="policy_id" value={policy.id} />
              <label htmlFor="changes-note" className="muted" style={{ fontSize: 13 }}>
                What needs changing?
              </label>
              <input id="changes-note" type="text" name="note" placeholder="Describe required changes" />
              <button type="submit" className="btn secondary">
                Request changes
              </button>
            </form>
          </div>

          {reviews.length > 0 ? (
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Review history</h3>
              <ul>
                {reviews.map((r) => (
                  <li key={r.id} className="muted" style={{ fontSize: 13 }}>
                    {r.decision === "approved" ? "Approved" : "Changes requested"}
                    {r.createdAt ? ` · ${r.createdAt.slice(0, 10)}` : ""}
                    {r.note ? ` — ${r.note}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </aside>
      </div>
    </main>
  );
}
