import { randomUUID, createHash } from "node:crypto";
import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];

type Args = {
  organization_id?: unknown;
  policy_type?: unknown;
  requested_by_user_id?: unknown;
  reason?: unknown;
  cited_artifact_ids?: unknown;
  snapshot_id?: unknown;
};

type DbLike = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

type GatewayResponse = {
  content?: string;
  text?: string;
  output_text?: string;
};

const ALLOWED_POLICY_TYPES = new Set<string>([
  "access_control_policy",
  "change_management_policy",
  "incident_response_policy",
  "vendor_management_policy",
  "security_awareness_policy",
]);

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (typeof v === "string" ? v.trim() : "")).filter((v) => v.length > 0);
}

function getDb(ctx: HandlerContext): DbLike | null {
  const maybeDb = (ctx as unknown as { db?: DbLike }).db;
  return maybeDb && typeof maybeDb.query === "function" ? maybeDb : null;
}

function extractText(resp: GatewayResponse | string): string {
  if (typeof resp === "string") return resp;
  return resp.output_text ?? resp.content ?? resp.text ?? "";
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

async function callGateway(ctx: HandlerContext, prompt: string): Promise<string> {
  const callModel = (ctx as unknown as { callModel?: (input: Record<string, JsonValue>) => Promise<GatewayResponse | string> }).callModel;
  if (typeof callModel !== "function") {
    throw new Error("gateway_unavailable");
  }

  const response = await callModel({
    model: "claude-sonnet",
    messages: [
      {
        role: "system",
        content:
          "You draft SOC2 policy text only from provided facts. Return JSON with keys title, summary, markdown_body, claims.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
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
  });

  return extractText(response);
}

export async function handleGenerateGroundedPolicy(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  try {
    const organizationId = asString(args.organization_id);
    const policyType = asString(args.policy_type);
    const requestedByUserId = asString(args.requested_by_user_id);
    const reason = asString(args.reason) ?? "customer_request";
    const citedArtifactIds = asStringArray(args.cited_artifact_ids);
    const snapshotId = asString(args.snapshot_id);

    if (!organizationId || !policyType || !requestedByUserId) {
      return {
        ok: false,
        error: "invalid_arguments",
        autonomy: "human_review",
      } as HandlerResult;
    }

    if (!ALLOWED_POLICY_TYPES.has(policyType)) {
      return {
        ok: false,
        error: "unsupported_policy_type",
        autonomy: "human_review",
      } as HandlerResult;
    }

    const db = getDb(ctx);
    if (!db) {
      return {
        ok: false,
        error: "db_unavailable",
        autonomy: "human_review",
      } as HandlerResult;
    }

    const factsResult = await db.query(
      `
      select
        artifact_id,
        control_id,
        fact_key,
        fact_value
      from soc2_grounding_facts
      where organization_id = $1
        and policy_type = $2
      order by control_id asc, artifact_id asc, fact_key asc
      `,
      [organizationId, policyType],
    );

    const allowedArtifacts = new Set(
      factsResult.rows
        .map((r) => (typeof r.artifact_id === "string" ? r.artifact_id : null))
        .filter((v): v is string => Boolean(v)),
    );

    const invalidCitations = citedArtifactIds.filter((id) => !allowedArtifacts.has(id));
    if (invalidCitations.length > 0) {
      return {
        ok: false,
        error: "invalid_cited_artifacts",
        autonomy: "human_review",
        data: { invalid_artifact_ids: invalidCitations },
      } as HandlerResult;
    }

    const factsTable = factsResult.rows
      .map((r) => {
        const artifactId = typeof r.artifact_id === "string" ? r.artifact_id : "";
        const controlId = typeof r.control_id === "string" ? r.control_id : "";
        const factKey = typeof r.fact_key === "string" ? r.fact_key : "";
        const factValue = typeof r.fact_value === "string" ? r.fact_value : JSON.stringify(r.fact_value ?? "");
        return `artifact=${artifactId} | control=${controlId} | ${factKey}=${factValue}`;
      })
      .join("\n");

    const prompt = [
      `Organization: ${organizationId}`,
      `Policy type: ${policyType}`,
      `Reason: ${reason}`,
      snapshotId ? `Snapshot: ${snapshotId}` : "",
      citedArtifactIds.length ? `Requested cited artifacts: ${citedArtifactIds.join(", ")}` : "",
      "Facts table:",
      factsTable || "(no facts found)",
      "Requirements:",
      "- Only make claims supported by facts table.",
      "- Every claim must cite one artifact_id from facts table.",
      "- Keep policy practical and audit-friendly.",
    ]
      .filter(Boolean)
      .join("\n");

    const modelText = await callGateway(ctx, prompt);

    let parsed: {
      title: string;
      summary: string;
      markdown_body: string;
      claims: Array<{ statement: string; artifact_id: string }>;
    };

    try {
      parsed = JSON.parse(modelText) as typeof parsed;
    } catch {
      return {
        ok: false,
        error: "model_output_not_json",
        autonomy: "human_review",
      } as HandlerResult;
    }

    const claims = Array.isArray(parsed.claims) ? parsed.claims : [];
    const badClaim = claims.find(
      (c) =>
        !c ||
        typeof c.statement !== "string" ||
        typeof c.artifact_id !== "string" ||
        !allowedArtifacts.has(c.artifact_id),
    );

    if (badClaim) {
      return {
        ok: false,
        error: "claim_verification_failed",
        autonomy: "human_review",
      } as HandlerResult;
    }

    const versionId = randomUUID();
    const nowIso = new Date().toISOString();
    const payload = {
      title: parsed.title,
      summary: parsed.summary,
      markdown_body: parsed.markdown_body,
      claims,
      policy_type: policyType,
      grounded_artifact_ids: [...new Set(claims.map((c) => c.artifact_id))],
      generated_at: nowIso,
    };
    const payloadJson = JSON.stringify(payload);
    const contentHash = sha256(payloadJson);

    await db.query(
      `
      insert into soc2_policy_versions (
        id,
        organization_id,
        policy_type,
        status,
        content_json,
        content_sha256,
        requested_by_user_id,
        generation_reason,
        created_at
      ) values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::timestamptz)
      `,
      [
        versionId,
        organizationId,
        policyType,
        "in_review",
        payloadJson,
        contentHash,
        requestedByUserId,
        reason,
        nowIso,
      ],
    );

    return {
      ok: true,
      autonomy: "human_review",
      data: {
        policy_version_id: versionId,
        status: "in_review",
        content_sha256: contentHash,
      },
    } as HandlerResult;
  } catch (error) {
    return {
      ok: false,
      error: "generate_grounded_policy_failed",
      autonomy: "human_review",
      data: {
        message: error instanceof Error ? error.message : "unknown_error",
      },
    } as HandlerResult;
  }
}
