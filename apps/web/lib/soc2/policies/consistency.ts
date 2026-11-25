/**
 * SOC 2 policy claim-verification + staleness layer (F1-005).
 *
 * Server-only, mostly pure. This is the concrete mitigation for feasibility
 * risks #1 (hallucination) and #3 (cross-document consistency):
 *
 *   1. verifyClaims()  — asserts every factual claim in a generated draft cites
 *      an evidence artifact_id that actually exists in the canonical grounding
 *      context. A claim citing a non-existent artifact is REJECTED (and the
 *      caller regenerates). This is "a deterministic mapping the LLM cannot
 *      override".
 *   2. lintPolicy()    — re-runs the forbidden-attestation-term lint over the
 *      model output (defence in depth; the prompt already forbids the terms).
 *   3. detectAndFlagStalePolicies() — approved policies auto-flip to 'stale'
 *      when a LATER snapshot changes a cited artifact: the sha256 recorded in
 *      content_json.artifact_hashes no longer matches the live evidence artifact.
 *
 * Every SQL query is parameterized ($1, $2, …).
 */

import { getScanPool } from "@/lib/soc2/scan/access";
import { findForbiddenTerms } from "@/lib/soc2/policies/prompts";

interface Pool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
}

/** A single grounded claim emitted by the generative layer. */
export interface GroundedClaim {
  statement: string;
  artifactId: string;
}

/** The structural output of one gateway draft (post-parse). */
export interface GeneratedPolicy {
  title: string;
  summary: string;
  markdownBody: string;
  claims: GroundedClaim[];
}

/** Result of the citation-existence verification pass. */
export interface ClaimVerification {
  ok: boolean;
  verified: GroundedClaim[];
  unverified: GroundedClaim[];
  unverifiedArtifactIds: string[];
}

/** Verify every claim cites an artifact that exists in the grounding context. */
export function verifyClaims(
  claims: GroundedClaim[],
  allowedArtifactIds: Set<string>,
): ClaimVerification {
  const verified: GroundedClaim[] = [];
  const unverified: GroundedClaim[] = [];
  for (const claim of claims) {
    if (claim.artifactId && allowedArtifactIds.has(claim.artifactId)) {
      verified.push(claim);
    } else {
      unverified.push(claim);
    }
  }
  const unverifiedArtifactIds = [...new Set(unverified.map((c) => c.artifactId).filter(Boolean))];
  return {
    ok: unverified.length === 0 && claims.length > 0,
    verified,
    unverified,
    unverifiedArtifactIds,
  };
}

/** Result of the forbidden-attestation-term lint. */
export interface LintResult {
  ok: boolean;
  forbiddenTerms: string[];
}

/** Re-run the attestation-term lint over every text surface of a draft. */
export function lintPolicy(policy: GeneratedPolicy): LintResult {
  const corpus = [
    policy.title,
    policy.summary,
    policy.markdownBody,
    ...policy.claims.map((c) => c.statement),
  ].join("\n");
  const forbiddenTerms = findForbiddenTerms(corpus);
  return { ok: forbiddenTerms.length === 0, forbiddenTerms };
}

/** Combined consistency verdict (claims + lint) for one draft. */
export interface ConsistencyResult {
  ok: boolean;
  claims: ClaimVerification;
  lint: LintResult;
  reasons: string[];
}

/**
 * Run the full consistency gate over a parsed draft. A draft passes only when
 * every claim is grounded AND the prose is free of attestation language.
 */
export function checkConsistency(
  policy: GeneratedPolicy,
  allowedArtifactIds: Set<string>,
): ConsistencyResult {
  const claims = verifyClaims(policy.claims, allowedArtifactIds);
  const lint = lintPolicy(policy);
  const reasons: string[] = [];
  if (policy.claims.length === 0) {
    reasons.push("draft contains no grounded claims");
  }
  if (claims.unverifiedArtifactIds.length > 0) {
    reasons.push(`claims cite non-existent artifacts: ${claims.unverifiedArtifactIds.join(", ")}`);
  }
  if (!lint.ok) {
    reasons.push(`forbidden attestation terms present: ${lint.forbiddenTerms.join(", ")}`);
  }
  return { ok: claims.ok && lint.ok, claims, lint, reasons };
}

interface StalePolicyRow {
  id: string;
  content_json: unknown;
  cited_artifact_ids: unknown;
}

/** Pull `artifact_hashes` (artifact_id -> sha256) out of a content_json blob. */
function readArtifactHashes(contentJson: unknown): Record<string, string> {
  if (!contentJson || typeof contentJson !== "object") return {};
  const hashes = (contentJson as Record<string, unknown>).artifact_hashes;
  if (!hashes || typeof hashes !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(hashes as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}

/**
 * Scan an organization's APPROVED policies and flip any whose cited evidence has
 * changed to 'stale'. "Changed" means a cited artifact's live sha256 differs
 * from the hash captured when the policy was generated, or the artifact was
 * removed entirely. Returns the number of policies flipped.
 */
export async function detectAndFlagStalePolicies(
  organizationId: string,
  pool: Pool = getScanPool(),
): Promise<number> {
  const { rows } = await pool.query(
    `SELECT id, content_json, cited_artifact_ids
       FROM soc2_policy_versions
      WHERE organization_id = $1 AND status = 'approved'`,
    [organizationId],
  );

  let flipped = 0;
  for (const raw of rows as StalePolicyRow[]) {
    const policyId = String(raw.id);
    const expected = readArtifactHashes(raw.content_json);
    const artifactIds = Object.keys(expected);
    if (artifactIds.length === 0) continue;

    const { rows: current } = await pool.query(
      `SELECT id, sha256
         FROM soc2_evidence_artifacts
        WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [organizationId, artifactIds],
    );
    const live = new Map<string, string>();
    for (const r of current as Array<Record<string, unknown>>) {
      live.set(String(r.id), r.sha256 ? String(r.sha256) : "");
    }

    const isStale = artifactIds.some((id) => live.get(id) !== expected[id]);
    if (!isStale) continue;

    const updated = await pool.query(
      `UPDATE soc2_policy_versions
          SET status = 'stale', stale_at = now(), updated_at = now()
        WHERE id = $1 AND organization_id = $2 AND status = 'approved'`,
      [policyId, organizationId],
    );
    if ((updated.rowCount ?? 0) > 0) flipped += 1;
  }
  return flipped;
}
