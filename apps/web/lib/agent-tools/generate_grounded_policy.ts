/**
 * Company-local agent tool: `generate_grounded_policy`.
 *
 * Feature F1-DT002 — confirm-gated mutation (autonomy = human_review). The
 * analysis-class tools in this domain execute inline via the generic LLM
 * handler, but this is a MUTATION: it writes a `soc2_policy_versions` row, so
 * it routes through the cross-boundary bridge (the substrate approved-actions
 * cron) and lands the policy in status 'in_review' for a human to approve.
 * Registered in DOMAIN_DISPATCH (apps/web/lib/agent-tools/_dispatch.ts).
 *
 * This is the GENERATIVE layer of the two-layer SOC 2 architecture. It is only
 * allowed to describe facts the DETERMINISTIC layer has already established:
 *
 *   1. Build the canonical grounding facts table for ONE policy type from
 *      `soc2_grounding_facts` (one pre-computed facts set per org so every
 *      policy cites identical facts — addresses the long-context coherence
 *      risk from the feasibility analysis).
 *   2. Call the Nexus gateway (Claude Sonnet, JSON-schema constrained output)
 *      with a prompt constrained to those facts — drafting only, never control
 *      evaluation.
 *   3. Run a claim-verification pass that REJECTS any claim citing an
 *      artifact_id that is not present in the grounding facts (the concrete
 *      implementation of "a deterministic mapping the LLM cannot override").
 *   4. Persist one `soc2_policy_versions` row in status 'in_review' with a
 *      sha256 content hash for evidence integrity.
 *
 * DB access uses the lego HandlerContext `ctx.db` (pg-backed; $1,$2 params,
 * never string interpolation). Every row is scoped by organization_id.
 */

import { createHash } from "node:crypto";
import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

/** The five core SOC 2 CC policy suites in MVP scope. */
const ALLOWED_POLICY_TYPES = new Set<string>([
  "access_control_policy",
  "change_management_policy",
  "incident_response_policy",
  "vendor_management_policy",
  "security_awareness_policy",
]);

interface GroundingFactRow {
  artifact_id: string;
  control_ref: string | null;
  fact_key: string;
  fact_value: unknown;
}

interface GroundedClaim {
  statement: string;
  artifact_id: string;
}

interface GeneratedPolicy {
  title: string;
  summary: string;
  markdown_body: string;
  claims: GroundedClaim[];
}

/** Trim a value to a non-empty string, else null. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** RFC-4122 UUID validation (any version), normalized to lowercase. */
function asUuid(value: unknown): string | null {
  const v = asString(value);
  if (!v) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    ? v.toLowerCase()
    : null;
}

/** Normalize an unknown into a de-duplicated list of non-empty strings. */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    const s = asString(item);
    if (s) out.add(s);
  }
  return [...out];
}

/** Render a fact value compactly for the constrained prompt. */
function renderFactValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** SHA-256 hex of the canonical policy payload — evidence-integrity hash. */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Call the Nexus gateway for policy DRAFTING only (Claude Sonnet, JSON-schema
 * constrained output). No LLM is ever in the control-evaluation loop — this
 * only phrases facts the deterministic layer already established.
 *
 * Returns the raw model text (expected to be a JSON object matching the
 * grounded-policy schema). Throws `gateway_unavailable` /
 * `gateway_error:<status>` so the caller can map to an HTTP status.
 */
async function callGateway(prompt: string, factsTable: string): Promise<string> {
  const baseUrl = process.env.NEXUS_GATEWAY_URL ?? process.env.NEXUS_GATEWAY_BASE_URL;
  const token = process.env.NEXUS_GATEWAY_TOKEN ?? process.env.NEXUS_GATEWAY_API_KEY;
  if (!baseUrl || !token) {
    throw new Error("gateway_unavailable");
  }

  const model = process.env.NEXUS_GATEWAY_MODEL ?? "claude-sonnet-5";
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;

  const response = await fetch(endpoint, {
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
        {
          role: "system",
          content:
            "You draft SOC 2 policy text ONLY from the provided grounding facts. " +
            "Never invent controls, artifacts, or facts. Every claim MUST cite exactly " +
            "one artifact_id drawn from the facts table. Return a single JSON object with " +
            "keys title, summary, markdown_body, claims.",
        },
        {
          role: "user",
          content: `${prompt}\n\nGrounding facts (control -> artifact):\n${factsTable}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`gateway_error:${response.status}`);
  }

  const data: unknown = await response.json();
  return extractModelText(data);
}

/** Extract text from the gateway response across supported shapes. */
function extractModelText(data: unknown): string {
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return "";
  const obj = data as Record<string, unknown>;

  // Anthropic messages shape: { content: [{ type: "text", text }] }
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

  // OpenAI-compatible shape: { choices: [{ message: { content } }] }
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const first = obj.choices[0] as Record<string, unknown>;
    const message = first?.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === "string") return message.content;
  }

  // Flat fallbacks used by some gateway proxies.
  for (const key of ["output_text", "text", "completion"]) {
    const v = obj[key];
    if (typeof v === "string") return v;
  }
  return "";
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
    claims.push({ statement, artifact_id: artifactId });
  }

  return { title, summary, markdown_body: markdownBody, claims };
}

/**
 * Agent-tool handler. Signature matches lego handlers:
 * `(ctx, args) => Promise<HandlerResult>`.
 */
export async function handleGenerateGroundedPolicy(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const organizationId = asUuid(args.organization_id) ?? asUuid(args.organizationId);
  if (!organizationId) {
    return { status: 400, body: "organization_id is required and must be a UUID" };
  }

  const policyType = asString(args.policy_type) ?? asString(args.policyType);
  if (!policyType || !ALLOWED_POLICY_TYPES.has(policyType)) {
    return {
      status: 422,
      body: {
        error: "unsupported_policy_type",
        allowed_policy_types: [...ALLOWED_POLICY_TYPES],
      },
    };
  }

  const requestedByUserId =
    asUuid(args.requested_by_user_id) ?? asUuid(args.requestedByUserId);
  const reason = asString(args.reason) ?? "customer_request";
  const snapshotId = asUuid(args.snapshot_id) ?? asUuid(args.snapshotId);
  const citedArtifactIds = asStringArray(args.cited_artifact_ids ?? args.citedArtifactIds);

  try {
    // 1. Load the canonical grounding facts for this org + policy type.
    const facts = await ctx.db.query<GroundingFactRow>(
      `SELECT artifact_id, control_ref, fact_key, fact_value
         FROM soc2_grounding_facts
        WHERE organization_id = $1
          AND policy_type = $2
        ORDER BY control_ref NULLS LAST, artifact_id, fact_key`,
      organizationId,
      policyType,
    );

    if (facts.length === 0) {
      return {
        status: 422,
        body: {
          error: "no_grounding_facts",
          detail:
            "No grounding facts exist for this policy type; run ingestion + control checks first.",
          organization_id: organizationId,
          policy_type: policyType,
        },
      };
    }

    const allowedArtifacts = new Set<string>();
    for (const row of facts) {
      if (typeof row.artifact_id === "string" && row.artifact_id.length > 0) {
        allowedArtifacts.add(row.artifact_id);
      }
    }

    // Reject caller-supplied citations that are not grounded before spending a
    // gateway call — the LLM must never be handed a non-existent artifact.
    const invalidCitations = citedArtifactIds.filter((id) => !allowedArtifacts.has(id));
    if (invalidCitations.length > 0) {
      return {
        status: 422,
        body: { error: "invalid_cited_artifacts", invalid_artifact_ids: invalidCitations },
      };
    }

    const factsTable = facts
      .map(
        (row) =>
          `control=${row.control_ref ?? "n/a"} | artifact=${row.artifact_id} | ${row.fact_key}=${renderFactValue(
            row.fact_value,
          )}`,
      )
      .join("\n");

    // 2. Call the gateway with a prompt constrained to the facts table.
    const prompt = [
      `Draft the "${policyType}" SOC 2 policy for organization ${organizationId}.`,
      `Generation reason: ${reason}.`,
      snapshotId ? `Evidence snapshot: ${snapshotId}.` : "",
      citedArtifactIds.length
        ? `The customer specifically asked you to cite: ${citedArtifactIds.join(", ")}.`
        : "",
      "Rules: only state facts present in the grounding facts; every claim cites one artifact_id from the table; keep the policy practical and audit-friendly.",
    ]
      .filter((line) => line.length > 0)
      .join("\n");

    let modelText: string;
    try {
      modelText = await callGateway(prompt, factsTable);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "gateway_error";
      const status = message === "gateway_unavailable" ? 503 : 502;
      return { status, body: { error: message } };
    }

    const policy = parsePolicy(modelText);
    if (!policy) {
      return { status: 502, body: { error: "model_output_not_json" } };
    }

    // 3. Claim verification — reject any claim citing a non-grounded artifact.
    const unverifiedClaims = policy.claims.filter(
      (claim) => !allowedArtifacts.has(claim.artifact_id),
    );
    if (unverifiedClaims.length > 0) {
      return {
        status: 422,
        body: {
          error: "claim_verification_failed",
          detail: "Generated policy cited artifact IDs with no grounding fact; draft rejected.",
          unverified_artifact_ids: [...new Set(unverifiedClaims.map((c) => c.artifact_id))],
        },
      };
    }

    // 4. Persist the verified draft as a soc2_policy_versions row in 'in_review'.
    const groundedArtifactIds = [...new Set(policy.claims.map((c) => c.artifact_id))];
    const contentPayload = {
      title: policy.title,
      summary: policy.summary,
      markdown_body: policy.markdown_body,
      claims: policy.claims,
      policy_type: policyType,
      grounded_artifact_ids: groundedArtifactIds,
      snapshot_id: snapshotId,
    };
    const contentJson = JSON.stringify(contentPayload);
    const contentHash = sha256Hex(contentJson);

    const inserted = await ctx.db.query<{ id: string }>(
      `INSERT INTO soc2_policy_versions
         (organization_id, policy_type, status, title, summary,
          content_json, content_hash, cited_artifact_ids, requested_by_user_id,
          snapshot_id, generation_reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10, $11, now())
       RETURNING id`,
      organizationId,
      policyType,
      "in_review",
      policy.title,
      policy.summary,
      contentJson,
      contentHash,
      JSON.stringify(groundedArtifactIds),
      requestedByUserId,
      snapshotId,
      reason,
    );

    const policyVersionId = inserted[0]?.id;
    if (!policyVersionId) {
      return { status: 500, body: "Failed to persist soc2_policy_versions row" };
    }

    // Fire-and-forget domain event for downstream review/approval surfaces.
    await ctx.events.publish("soc2.policy_version.created", {
      organization_id: organizationId,
      policy_version_id: policyVersionId,
      policy_type: policyType,
      status: "in_review",
      content_hash: contentHash,
      generation_reason: reason,
    });

    return {
      status: 200,
      body: {
        policy_version_id: policyVersionId,
        organization_id: organizationId,
        policy_type: policyType,
        status: "in_review",
        autonomy: "human_review",
        content_hash: contentHash,
        grounded_artifact_ids: groundedArtifactIds,
        claim_count: policy.claims.length,
      },
    };
  } catch (error: unknown) {
    return {
      status: 500,
      body: error instanceof Error ? error.message : "generate_grounded_policy failed",
    };
  }
}
