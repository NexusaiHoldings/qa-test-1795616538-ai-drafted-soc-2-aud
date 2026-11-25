/**
 * SOC 2 grounded policy generation + persistence service (F1-005).
 *
 * Server-only. Orchestrates the GENERATIVE layer end-to-end:
 *
 *   1. Assemble the canonical grounding context (grounding.ts) — only present
 *      controls contribute facts.
 *   2. Call the Nexus gateway (Claude Sonnet, JSON-schema constrained output)
 *      with a prompt locked to those facts (prompts.ts) — drafting only, never
 *      control evaluation.
 *   3. Run the consistency gate (consistency.ts): every claim must cite a real
 *      artifact and the prose must be free of attestation language. On failure
 *      the draft is REJECTED and regenerated (bounded retries).
 *   4. Persist a `soc2_policy_versions` row in status 'draft' with a sha256
 *      content hash and the per-artifact hashes that drive the stale check.
 *
 * Also exposes the read/review helpers the (soc2)/policies pages consume so all
 * server-side policy logic lives inside the carve-out. Every query is
 * parameterized ($1, $2, …).
 */

import { createHash } from "node:crypto";
import { getScanPool } from "@/lib/soc2/scan/access";
import {
  assembleGroundingContext,
  persistGroundingFacts,
  type GroundingContext,
  type GroundingFact,
} from "@/lib/soc2/policies/grounding";
import {
  buildUserPrompt,
  SYSTEM_PROMPT,
  POLICY_TYPE_META,
  type PolicyType,
} from "@/lib/soc2/policies/prompts";
import {
  checkConsistency,
  type GeneratedPolicy,
  type GroundedClaim,
} from "@/lib/soc2/policies/consistency";

interface Pool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
}

/** Thrown for every expected failure so Server Actions can map a user message. */
export class PolicyGenerationError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "PolicyGenerationError";
    this.code = code;
  }
}

const MAX_GENERATION_ATTEMPTS = 3;

/** SHA-256 hex of a canonical payload — the evidence-integrity hash. */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Trim a value to a non-empty string, else null. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/* ------------------------------------------------------------------ gateway */

/** Extract text from the gateway response across the supported shapes. */
function extractModelText(data: unknown): string {
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return "";
  const obj = data as Record<string, unknown>;

  if (Array.isArray(obj.content)) {
    const parts = obj.content
      .map((block) =>
        block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string"
          ? ((block as Record<string, unknown>).text as string)
          : "",
      )
      .filter((t) => t.length > 0);
    if (parts.length > 0) return parts.join("");
  }

  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const first = obj.choices[0] as Record<string, unknown>;
    const message = first?.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === "string") return message.content;
  }

  for (const key of ["output_text", "text", "completion"]) {
    const v = obj[key];
    if (typeof v === "string") return v;
  }
  return "";
}

/**
 * Call the Nexus gateway for policy DRAFTING only. Throws PolicyGenerationError
 * with code 'gateway_unavailable' / 'gateway_error' so the caller maps a status.
 */
async function callGateway(systemPrompt: string, userPrompt: string): Promise<string> {
  const baseUrl = process.env.NEXUS_GATEWAY_URL ?? process.env.NEXUS_GATEWAY_BASE_URL;
  const token = process.env.NEXUS_GATEWAY_TOKEN ?? process.env.NEXUS_GATEWAY_API_KEY;
  if (!baseUrl || !token) {
    throw new PolicyGenerationError("gateway_unavailable", "Nexus gateway is not configured.");
  }

  const model = process.env.NEXUS_GATEWAY_MODEL ?? "claude-sonnet-5";
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "grounded_policy",
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["title", "summary", "markdown_body", "claims"],
              properties: {
                title: { type: "string" },
                summary: { type: "string" },
                markdown_body: { type: "string" },
                claims: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["statement", "artifact_id"],
                    properties: {
                      statement: { type: "string" },
                      artifact_id: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "network error";
    throw new PolicyGenerationError("gateway_error", `Gateway request failed: ${detail}`);
  }

  if (!response.ok) {
    throw new PolicyGenerationError("gateway_error", `Gateway returned ${response.status}`);
  }

  const data: unknown = await response.json();
  return extractModelText(data);
}

/** Parse + shape-check the model output into a GeneratedPolicy, or null. */
function parsePolicy(modelText: string): GeneratedPolicy | null {
  let raw: unknown;
  try {
    raw = JSON.parse(modelText);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const title = asString(obj.title);
  const summary = asString(obj.summary);
  const markdownBody = asString(obj.markdown_body);
  if (!title || !summary || !markdownBody || !Array.isArray(obj.claims)) return null;

  const claims: GroundedClaim[] = [];
  for (const entry of obj.claims) {
    if (!entry || typeof entry !== "object") return null;
    const c = entry as Record<string, unknown>;
    const statement = asString(c.statement);
    const artifactId = asString(c.artifact_id);
    if (!statement || !artifactId) return null;
    claims.push({ statement, artifactId });
  }

  return { title, summary, markdownBody, claims };
}

/* ------------------------------------------------------- content assembly */

/** Build the per-artifact reference map stored in content_json. */
function buildArtifactMap(facts: GroundingFact[]): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const f of facts) {
    if (map[f.artifactId]) continue;
    map[f.artifactId] = {
      control_ref: f.controlRef,
      control_title: f.controlTitle,
      rule_title: f.ruleTitle,
      json_path: f.jsonPath,
      sha256: f.sha256,
      provider: f.provider,
      resource_type: f.resourceType,
      excerpt: f.factValue,
      collected_at: f.collectedAt,
    };
  }
  return map;
}

export interface GeneratePolicyInput {
  organizationId: string;
  policyType: PolicyType;
  requestedByUserId?: string | null;
  revisionNote?: string | null;
}

export interface GeneratePolicyResult {
  policyVersionId: string;
  policyType: PolicyType;
  status: string;
  versionNumber: number;
  contentHash: string;
  claimCount: number;
}

/**
 * Generate ONE grounded policy draft, verify it, and persist it in 'draft'.
 * Regenerates (bounded) when the consistency gate rejects a draft.
 */
export async function generatePolicy(
  input: GeneratePolicyInput,
  pool: Pool = getScanPool(),
): Promise<GeneratePolicyResult> {
  const context: GroundingContext = await assembleGroundingContext(input.organizationId, pool);
  if (context.facts.length === 0) {
    throw new PolicyGenerationError(
      "no_grounding",
      "No present controls to ground on. Connect AWS and run a gap scan first.",
    );
  }

  // Keep the shared facts table in sync so the agent-tool path and UI agree.
  try {
    await persistGroundingFacts(input.organizationId, input.policyType, context.facts, pool);
  } catch {
    // Non-fatal: the in-memory context already carries the facts for drafting.
  }

  const userPrompt = buildUserPrompt({
    organizationId: input.organizationId,
    policyType: input.policyType,
    facts: context.facts,
    revisionNote: input.revisionNote,
  });

  let policy: GeneratedPolicy | null = null;
  let lastReasons: string[] = ["model output could not be parsed"];
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const modelText = await callGateway(SYSTEM_PROMPT, userPrompt);
    const parsed = parsePolicy(modelText);
    if (!parsed) {
      lastReasons = ["model output was not valid grounded-policy JSON"];
      continue;
    }
    const verdict = checkConsistency(parsed, context.allowedArtifactIds);
    if (verdict.ok) {
      policy = parsed;
      break;
    }
    lastReasons = verdict.reasons;
  }

  if (!policy) {
    throw new PolicyGenerationError(
      "consistency_failed",
      `Draft rejected after ${MAX_GENERATION_ATTEMPTS} attempts: ${lastReasons.join("; ")}`,
    );
  }

  const groundedArtifactIds = [...new Set(policy.claims.map((c) => c.artifactId))];
  const artifactHashes: Record<string, string> = {};
  for (const id of groundedArtifactIds) {
    if (context.artifactHashes[id]) artifactHashes[id] = context.artifactHashes[id];
  }

  const contentPayload = {
    title: policy.title,
    summary: policy.summary,
    markdown_body: policy.markdownBody,
    claims: policy.claims.map((c) => ({ statement: c.statement, artifact_id: c.artifactId })),
    policy_type: input.policyType,
    grounded_artifact_ids: groundedArtifactIds,
    snapshot_id: context.latestSnapshotId,
    artifact_hashes: artifactHashes,
    artifacts: buildArtifactMap(context.facts),
  };
  const contentJson = JSON.stringify(contentPayload);
  const contentHash = sha256Hex(contentJson);

  const { rows: verRows } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM soc2_policy_versions
      WHERE organization_id = $1 AND policy_type = $2`,
    [input.organizationId, input.policyType],
  );
  const versionNumber = Number((verRows[0] as Record<string, unknown>)?.n ?? 0) + 1;

  const inserted = await pool.query(
    `INSERT INTO soc2_policy_versions
       (organization_id, policy_type, version_number, status, title, summary,
        content_json, content_hash, cited_artifact_ids, snapshot_id,
        generation_reason, requested_by_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, 'draft', $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10, $11, now(), now())
     RETURNING id`,
    [
      input.organizationId,
      input.policyType,
      versionNumber,
      policy.title,
      policy.summary,
      contentJson,
      contentHash,
      JSON.stringify(groundedArtifactIds),
      context.latestSnapshotId,
      input.revisionNote ? "revision" : "customer_request",
      input.requestedByUserId ?? null,
    ],
  );
  const policyVersionId = String((inserted.rows[0] as Record<string, unknown>).id);

  return {
    policyVersionId,
    policyType: input.policyType,
    status: "draft",
    versionNumber,
    contentHash,
    claimCount: policy.claims.length,
  };
}

/* ------------------------------------------------------------- read models */

export type PolicyStatus = "draft" | "in_review" | "approved" | "stale";

export interface PolicyListItem {
  id: string;
  policyType: string;
  label: string;
  status: string;
  title: string;
  versionNumber: number;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyArtifactRef {
  artifactId: string;
  controlRef: string;
  controlTitle: string;
  ruleTitle: string;
  jsonPath: string;
  sha256: string;
  provider: string;
  resourceType: string;
  excerpt: unknown;
  collectedAt: string | null;
}

export interface PolicyDetail {
  id: string;
  organizationId: string;
  policyType: string;
  label: string;
  status: string;
  title: string;
  summary: string;
  markdownBody: string;
  versionNumber: number;
  claims: GroundedClaim[];
  artifacts: Record<string, PolicyArtifactRef>;
  citedArtifactIds: string[];
  snapshotId: string | null;
  contentHash: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  approvedAt: string | null;
  staleAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyReview {
  id: string;
  reviewerUserId: string | null;
  decision: string;
  note: string;
  createdAt: string;
}

/** Human label for a policy_type, falling back to a title-cased key. */
function labelFor(policyType: string): string {
  const meta = POLICY_TYPE_META[policyType as PolicyType];
  if (meta) return meta.label;
  return policyType
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

/** List the LATEST version of each policy type for the document grid. */
export async function listPolicies(
  organizationId: string,
  pool: Pool = getScanPool(),
): Promise<PolicyListItem[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (policy_type)
            id, policy_type, status, title, version_number, created_at, updated_at
       FROM soc2_policy_versions
      WHERE organization_id = $1
      ORDER BY policy_type, version_number DESC, created_at DESC`,
    [organizationId],
  );
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    policyType: String(r.policy_type),
    label: labelFor(String(r.policy_type)),
    status: String(r.status),
    title: String(r.title ?? ""),
    versionNumber: Number(r.version_number ?? 1),
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  }));
}

function parseClaims(content: Record<string, unknown>): GroundedClaim[] {
  const raw = content.claims;
  if (!Array.isArray(raw)) return [];
  const claims: GroundedClaim[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const c = entry as Record<string, unknown>;
    const statement = asString(c.statement);
    const artifactId = asString(c.artifact_id) ?? asString((c as Record<string, unknown>).artifactId);
    if (statement && artifactId) claims.push({ statement, artifactId });
  }
  return claims;
}

function parseArtifacts(content: Record<string, unknown>): Record<string, PolicyArtifactRef> {
  const raw = asObject(content.artifacts);
  const out: Record<string, PolicyArtifactRef> = {};
  for (const [id, value] of Object.entries(raw)) {
    const a = asObject(value);
    out[id] = {
      artifactId: id,
      controlRef: asString(a.control_ref) ?? "n/a",
      controlTitle: asString(a.control_title) ?? "",
      ruleTitle: asString(a.rule_title) ?? "",
      jsonPath: asString(a.json_path) ?? "",
      sha256: asString(a.sha256) ?? "",
      provider: asString(a.provider) ?? "",
      resourceType: asString(a.resource_type) ?? "",
      excerpt: a.excerpt ?? {},
      collectedAt: asString(a.collected_at),
    };
  }
  return out;
}

/** Load one policy version with its parsed claims + artifact references. */
export async function getPolicy(
  organizationId: string,
  policyVersionId: string,
  pool: Pool = getScanPool(),
): Promise<PolicyDetail | null> {
  const { rows } = await pool.query(
    `SELECT id, organization_id, policy_type, status, title, summary,
            content_json, content_hash, cited_artifact_ids, version_number,
            snapshot_id, reviewed_by, reviewed_at, approved_at, stale_at,
            created_at, updated_at
       FROM soc2_policy_versions
      WHERE id = $1 AND organization_id = $2
      LIMIT 1`,
    [policyVersionId, organizationId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;

  const content = asObject(row.content_json);
  const citedRaw = row.cited_artifact_ids;
  const cited = Array.isArray(citedRaw)
    ? citedRaw.map((v) => String(v))
    : asString(citedRaw)
      ? (() => {
          try {
            const p = JSON.parse(String(citedRaw));
            return Array.isArray(p) ? p.map((v) => String(v)) : [];
          } catch {
            return [];
          }
        })()
      : [];

  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    policyType: String(row.policy_type),
    label: labelFor(String(row.policy_type)),
    status: String(row.status),
    title: String(row.title ?? ""),
    summary: String(row.summary ?? ""),
    markdownBody: asString(content.markdown_body) ?? "",
    versionNumber: Number(row.version_number ?? 1),
    claims: parseClaims(content),
    artifacts: parseArtifacts(content),
    citedArtifactIds: cited,
    snapshotId: row.snapshot_id ? String(row.snapshot_id) : null,
    contentHash: String(row.content_hash ?? ""),
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : null,
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    approvedAt: row.approved_at ? String(row.approved_at) : null,
    staleAt: row.stale_at ? String(row.stale_at) : null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

/** The immediately prior version of the same policy type, for the diff rail. */
export async function getPreviousVersion(
  organizationId: string,
  policyType: string,
  versionNumber: number,
  pool: Pool = getScanPool(),
): Promise<PolicyDetail | null> {
  const { rows } = await pool.query(
    `SELECT id
       FROM soc2_policy_versions
      WHERE organization_id = $1 AND policy_type = $2 AND version_number < $3
      ORDER BY version_number DESC
      LIMIT 1`,
    [organizationId, policyType, versionNumber],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return getPolicy(organizationId, String(row.id), pool);
}

/** The full review decision trail for one policy version (newest first). */
export async function listPolicyReviews(
  organizationId: string,
  policyVersionId: string,
  pool: Pool = getScanPool(),
): Promise<PolicyReview[]> {
  const { rows } = await pool.query(
    `SELECT id, reviewer_user_id, decision, note, created_at
       FROM soc2_policy_reviews
      WHERE organization_id = $1 AND policy_version_id = $2
      ORDER BY created_at DESC`,
    [organizationId, policyVersionId],
  );
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    reviewerUserId: r.reviewer_user_id ? String(r.reviewer_user_id) : null,
    decision: String(r.decision),
    note: String(r.note ?? ""),
    createdAt: String(r.created_at ?? ""),
  }));
}

/** Move a draft into human review. */
export async function submitForReview(
  organizationId: string,
  policyVersionId: string,
  pool: Pool = getScanPool(),
): Promise<void> {
  await pool.query(
    `UPDATE soc2_policy_versions
        SET status = 'in_review', updated_at = now()
      WHERE id = $1 AND organization_id = $2 AND status IN ('draft', 'stale')`,
    [policyVersionId, organizationId],
  );
}

export type ReviewDecision = "approved" | "changes_requested";

/**
 * Record a human review decision (the mandatory sign-off). 'approved' flips the
 * version to 'approved'; 'changes_requested' returns it to 'draft'. Always
 * writes a soc2_policy_reviews audit row.
 */
export async function recordReview(
  organizationId: string,
  policyVersionId: string,
  reviewerUserId: string | null,
  decision: ReviewDecision,
  note: string,
  pool: Pool = getScanPool(),
): Promise<void> {
  const nextStatus = decision === "approved" ? "approved" : "draft";
  const approvedAtClause = decision === "approved" ? "now()" : "NULL";
  await pool.query(
    `UPDATE soc2_policy_versions
        SET status = $3,
            reviewed_by = $4,
            reviewed_at = now(),
            approved_at = ${approvedAtClause},
            stale_at = NULL,
            updated_at = now()
      WHERE id = $1 AND organization_id = $2`,
    [policyVersionId, organizationId, nextStatus, reviewerUserId],
  );
  await pool.query(
    `INSERT INTO soc2_policy_reviews
       (organization_id, policy_version_id, reviewer_user_id, decision, note)
     VALUES ($1, $2, $3, $4, $5)`,
    [organizationId, policyVersionId, reviewerUserId, decision, note.slice(0, 4000)],
  );
}
