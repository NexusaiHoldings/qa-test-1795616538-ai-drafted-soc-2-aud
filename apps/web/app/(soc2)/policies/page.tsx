/**
 * /policies — the grounded policy document grid (F1-005).
 *
 * The GENERATIVE layer's front door. A document grid with a card per SOC 2
 * policy suite, each showing a status pill (Draft / In review / Approved /
 * Stale). Generation is a Server Action that assembles the canonical grounding
 * context, calls the gateway, verifies every claim cites a real evidence
 * artifact, and lands a draft in 'draft' for human review.
 *
 * Server component — the only interactivity is the per-policy "Generate" form.
 * When an organization has no present controls to ground on we render the empty
 * state: "Connect AWS to generate your first policy". On view we re-run the
 * staleness check so approved policies whose evidence changed flip to 'stale'.
 */

import type { JSX } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { resolveScanAccess } from "@/lib/soc2/scan/access";
import { hasGroundingFacts } from "@/lib/soc2/policies/grounding";
import { detectAndFlagStalePolicies } from "@/lib/soc2/policies/consistency";
import { generatePolicy, listPolicies, PolicyGenerationError, type PolicyListItem } from "@/lib/soc2/policies/generate";
import { POLICY_TYPES, POLICY_TYPE_META, type PolicyType } from "@/lib/soc2/policies/prompts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LEGAL_NOTE =
  "Generated drafts require your legal team's review and sign-off before auditor submission. This is a drafting aid, not an audit opinion.";

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

function isPolicyType(value: string): value is PolicyType {
  return (POLICY_TYPES as string[]).includes(value);
}

const ERROR_MESSAGES: Record<string, string> = {
  no_grounding: "No present controls to ground on yet. Connect AWS and run a gap scan first.",
  gateway_unavailable: "The policy drafting service is not configured. Contact your administrator.",
  gateway_error: "The drafting service was unreachable. Please try again.",
  consistency_failed:
    "The draft could not be verified against your evidence and was rejected. Please try again.",
  bad_request: "That policy type is not supported.",
  unknown: "Something went wrong generating the policy. Please try again.",
};

/** Server Action: generate a grounded draft for one policy type. */
async function generatePolicyAction(formData: FormData): Promise<void> {
  "use server";
  const access = await resolveScanAccess();
  if (!access) {
    redirect("/connect");
  }
  const policyType = String(formData.get("policy_type") ?? "");
  if (!isPolicyType(policyType)) {
    redirect("/policies?error=bad_request");
  }

  try {
    const result = await generatePolicy({
      organizationId: access.organizationId,
      policyType,
      requestedByUserId: access.userId,
    });
    redirect(`/policies/${result.policyVersionId}/review`);
  } catch (error: unknown) {
    if (error instanceof PolicyGenerationError) {
      redirect(`/policies?error=${encodeURIComponent(error.code)}`);
    }
    // redirect() throws a control-flow signal — re-throw so navigation works.
    if (error instanceof Error && error.message === "NEXT_REDIRECT") throw error;
    const digest = (error as { digest?: string } | null)?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) throw error;
    redirect("/policies?error=unknown");
  }
}

function ExpiredState(): JSX.Element {
  return (
    <main>
      <h1>SOC 2 Policy Documents</h1>
      <p>Your session or workspace role has expired.</p>
      <div className="card">
        <h2>Re-verify to continue</h2>
        <p className="muted">We could not confirm an active workspace for your account.</p>
        <Link className="btn" href="/connect">
          Re-verify access
        </Link>
      </div>
    </main>
  );
}

export default async function Soc2PoliciesPage({
  searchParams,
}: {
  searchParams?: { error?: string };
}): Promise<JSX.Element> {
  const access = await resolveScanAccess();
  if (!access) {
    return <ExpiredState />;
  }

  // Flip any approved policy whose cited evidence changed to 'stale' before read.
  try {
    await detectAndFlagStalePolicies(access.organizationId);
  } catch {
    // Best-effort; a staleness-check failure must not block the grid.
  }

  const grounded = await hasGroundingFacts(access.organizationId);
  const existing: PolicyListItem[] = await listPolicies(access.organizationId);
  const byType = new Map<string, PolicyListItem>();
  for (const item of existing) byType.set(item.policyType, item);

  const errorKey = searchParams?.error;
  const errorMessage = errorKey ? (ERROR_MESSAGES[errorKey] ?? ERROR_MESSAGES.unknown) : null;

  if (!grounded) {
    return (
      <main>
        <h1>SOC 2 Policy Documents</h1>
        <p>
          Generate organization-specific access control, change management, incident response, vendor
          management and system operations policies — derived from your actual system state, not blank
          templates.
        </p>
        {errorMessage ? (
          <div className="card" style={{ borderColor: "#8a1c1c" }}>
            <p style={{ color: "#8a1c1c", margin: 0 }}>{errorMessage}</p>
          </div>
        ) : null}
        <div className="empty">
          <p>Connect AWS to generate your first policy</p>
          <Link className="btn" href="/connect/aws">
            Connect AWS
          </Link>
        </div>
        <p className="muted">{LEGAL_NOTE}</p>
      </main>
    );
  }

  return (
    <main>
      <h1>SOC 2 Policy Documents</h1>
      <p>
        Each policy is drafted only from controls your evidence shows are present, and every factual
        claim is checked to cite a real evidence artifact before the draft is saved.
      </p>

      {errorMessage ? (
        <div className="card" style={{ borderColor: "#8a1c1c" }}>
          <p style={{ color: "#8a1c1c", margin: 0 }}>{errorMessage}</p>
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
        {POLICY_TYPES.map((type) => {
          const meta = POLICY_TYPE_META[type];
          const item = byType.get(type);
          return (
            <div className="card" key={type} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                <h2 style={{ margin: 0, fontSize: 18 }}>{meta.label}</h2>
                {item ? <StatusPill status={item.status} /> : <span className="muted">Not generated</span>}
              </div>
              <p className="muted" style={{ margin: 0 }}>
                {meta.blurb}
              </p>
              {item ? (
                <>
                  <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                    Version {item.versionNumber} · {item.title}
                  </p>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Link className="btn secondary" href={`/policies/${item.id}`}>
                      View
                    </Link>
                    <Link className="btn" href={`/policies/${item.id}/review`}>
                      Review
                    </Link>
                  </div>
                  <form action={generatePolicyAction}>
                    <input type="hidden" name="policy_type" value={type} />
                    <button type="submit" className="btn secondary">
                      Regenerate
                    </button>
                  </form>
                </>
              ) : (
                <form action={generatePolicyAction}>
                  <input type="hidden" name="policy_type" value={type} />
                  <button type="submit">Generate</button>
                </form>
              )}
            </div>
          );
        })}
      </div>

      <p className="muted" style={{ marginTop: 20 }}>
        {LEGAL_NOTE}
      </p>
    </main>
  );
}
