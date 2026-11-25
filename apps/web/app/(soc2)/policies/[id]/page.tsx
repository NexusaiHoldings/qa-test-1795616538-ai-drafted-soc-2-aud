/**
 * /policies/[id] — the book-like read view of one generated policy (F1-005).
 *
 * Renders the approved/draft policy as readable prose with numbered inline
 * citation markers, followed by the grounded-claims register (every factual
 * assertion mapped to the exact evidence artifact it cites). Server component —
 * no client JS. The review surface with approve / request-changes actions lives
 * at /policies/[id]/review.
 */

import type { JSX } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveScanAccess } from "@/lib/soc2/scan/access";
import { getPolicy, type PolicyArtifactRef } from "@/lib/soc2/policies/generate";
import type { GroundedClaim } from "@/lib/soc2/policies/consistency";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LEGAL_NOTE =
  "This document requires your legal team's review and sign-off before auditor submission. It is a drafting aid, not an audit opinion.";

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

export default async function PolicyDetailPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const access = await resolveScanAccess();
  if (!access) {
    return (
      <main>
        <h1>Policy Document</h1>
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

  const claims: GroundedClaim[] = policy.claims;
  const citationIndex = new Map<string, number>();
  claims.forEach((c, i) => {
    if (!citationIndex.has(c.artifactId)) citationIndex.set(c.artifactId, i + 1);
  });

  return (
    <main>
      <p className="muted">
        <Link href="/policies">← All policies</Link>
      </p>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <h1 style={{ marginBottom: 4 }}>{policy.title}</h1>
        <StatusPill status={policy.status} />
      </div>
      <p>{policy.summary}</p>
      <p className="muted" style={{ fontSize: 13 }}>
        {policy.label} · Version {policy.versionNumber} · {claims.length} grounded claims ·{" "}
        {policy.snapshotId ? `evidence snapshot ${policy.snapshotId.slice(0, 8)}` : "no snapshot pinned"}
      </p>

      {policy.status === "stale" ? (
        <div className="card" style={{ borderColor: "#8a1c1c" }}>
          <p style={{ color: "#8a1c1c", margin: 0 }}>
            A later snapshot changed evidence this policy cites. Regenerate and re-approve before relying
            on it.
          </p>
        </div>
      ) : null}

      <article className="card" style={{ lineHeight: 1.7 }}>
        {policy.markdownBody ? renderProse(policy.markdownBody) : <p className="muted">No body.</p>}
      </article>

      <h2>Grounded claims</h2>
      {claims.length === 0 ? (
        <p className="muted">This draft recorded no grounded claims.</p>
      ) : (
        <ol>
          {claims.map((claim, i) => {
            const artifact: PolicyArtifactRef | undefined = policy.artifacts[claim.artifactId];
            return (
              <li key={`${claim.artifactId}-${i}`} style={{ marginBottom: 10 }}>
                {claim.statement}{" "}
                <sup style={{ color: "#3355cc", fontWeight: 600 }}>[{citationIndex.get(claim.artifactId)}]</sup>
                <br />
                <span className="muted" style={{ fontSize: 13 }}>
                  {artifact
                    ? `${artifact.controlRef} · ${artifact.ruleTitle} · artifact ${claim.artifactId.slice(0, 8)}`
                    : `artifact ${claim.artifactId.slice(0, 8)}`}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      <p style={{ marginTop: 20 }}>
        <Link className="btn" href={`/policies/${policy.id}/review`}>
          Open review
        </Link>
      </p>
      <p className="muted">{LEGAL_NOTE}</p>
    </main>
  );
}
