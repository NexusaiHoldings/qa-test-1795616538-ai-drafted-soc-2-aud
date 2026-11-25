import crypto from "node:crypto";
import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

type PolicyType = "access_control_policy";

type GroundingFact = {
  controlId: string;
  artifactId: string;
  title: string;
  summary: string;
  evidencePath: string;
};

type GatewayStructuredResponse = {
  title: string;
  body_markdown: string;
  claims: Array<{
    claim_id: string;
    statement: string;
    artifact_ids: string[];
  }>;
};

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`invalid_${name}`);
  }
  return value.trim();
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed: string = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asPolicyType(value: unknown): PolicyType {
  const v: string = asString(value, "policy_type");
  if (v !== "access_control_policy") {
    throw new Error("unsupported_policy_type");
  }
  return v;
}

function extractOrganizationId(ctx: HandlerContext): string {
  const maybeOrgId: unknown =
    (ctx as { organizationId?: unknown }).organizationId ??
    (ctx as { organization_id?: unknown }).organization_id;

  if (typeof maybeOrgId !== "string" || maybeOrgId.trim().length === 0) {
    throw new Error("missing_organization_id");
  }
  return maybeOrgId.trim();
}

function nowIso(): string {
  return new Date().toISOString();
}

function makePolicyPrompt(
  policyType: PolicyType,
  facts: GroundingFact[],
  additionalContext: string | null,
): string {
  const header: string = `You are drafting a SOC 2 ${policyType} using ONLY the supplied facts.
Do not invent controls, evidence, systems, or dates.
Return strict JSON with keys: title, body_markdown, claims.
Each claim must include artifact_ids that exist in facts.
`;

  const factsTable: string = facts
    .map(
      (f: GroundingFact, idx: number) =>
        `${idx + 1}. control=${f.controlId} artifact_id=${f.artifactId} title="${f.title}" summary="${f.summary}" path="${f.evidencePath}"`,
    )
    .join("\n");

  const contextLine: string = additionalContext
    ? `\nAdditional context from requester:\n${additionalContext}\n`
    : "";

  return `${header}
Grounding facts:
${factsTable}
${contextLine}
Output JSON only.
`;
}

function verifyClaims(
  response: GatewayStructuredResponse,
  facts: GroundingFact[],
): { ok: true } | { ok: false; reason: string } {
  const allowed: Set<string> = new Set<string>(facts.map((f: GroundingFact) => f.artifactId));
  for (const claim of response.claims) {
    if (!Array.isArray(claim.artifact_ids) || claim.artifact_ids.length === 0) {
      return { ok: false, reason: `claim_${claim.claim_id}_missing_artifacts` };
    }
    for (const artifactId of claim.artifact_ids) {
      if (!allowed.has(artifactId)) {
        return { ok: false, reason: `claim_${claim.claim_id}_unknown_artifact_${artifactId}` };
      }
    }
  }
  return { ok: true };
}

function stableHash(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

async function callGateway(prompt: string): Promise<GatewayStructuredResponse> {
  const gatewayUrl: string = process.env.NEXUS_LLM_GATEWAY_URL ?? "";
  const gatewayApiKey: string = process.env.NEXUS_LLM_GATEWAY_API_KEY ?? "";

  if (!gatewayUrl || !gatewayApiKey) {
    throw new Error("missing_gateway_config");
  }

  const schema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    required: ["title", "body_markdown", "claims"],
    properties: {
      title: { type: "string" },
      body_markdown: { type: "string" },
      claims: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["claim_id", "statement", "artifact_ids"],
          properties: {
            claim_id: { type: "string" },
            statement: { type: "string" },
            artifact_ids: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  };

  const response: Response = await fetch(gatewayUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${gatewayApiKey}`,
    },
    body: JSON.stringify({
      model: "claude-sonnet",
      temperature: 0.1,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "grounded_policy",
          schema,
        },
      },
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const text: string = await response.text();
    throw new Error(`gateway_error_${response.status}_${text}`);
  }

  const payload: unknown = await response.json();
  const content: unknown = (payload as { output?: unknown }).output ?? payload;

  if (
    typeof content !== "object" ||
    content === null ||
    typeof (content as { title?: unknown }).title !== "string" ||
    typeof (content as { body_markdown?: unknown }).body_markdown !== "string" ||
    !Array.isArray((content as { claims?: unknown }).claims)
  ) {
    throw new Error("invalid_gateway_response_shape");
  }

  return content as GatewayStructuredResponse;
}

export async function handleGenerateGroundedPolicy(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  try {
    const organizationId: string = extractOrganizationId(ctx);
    const policyType: PolicyType = asPolicyType(args.policy_type);
    const requestedByUserId: string = asString(args.requested_by_user_id, "requested_by_user_id");
    const trigger: string = asString(args.trigger, "trigger");
    const additionalContext: string | null = asOptionalString(args.additional_context);

    const groundingFacts: GroundingFact[] = [
      {
        controlId: "CC6.1",
        artifactId: "artifact-aws-iam-mfa-enforced",
        title: "AWS IAM MFA enforcement",
        summary: "MFA is required for interactive IAM users with console access.",
        evidencePath: "aws/iam/account-summary/mfa-report.json",
      },
      {
        controlId: "CC6.2",
        artifactId: "artifact-github-branch-protection",
        title: "GitHub branch protection",
        summary: "Default branch requires pull requests and status checks.",
        evidencePath: "github/repos/branch-protection.json",
      },
      {
        controlId: "CC6.3",
        artifactId: "artifact-cloudtrail-enabled",
        title: "CloudTrail enabled",
        summary: "Organization trails are enabled and log management events.",
        evidencePath: "aws/cloudtrail/trails.json",
      },
    ];

    const prompt: string = makePolicyPrompt(policyType, groundingFacts, additionalContext);
    const modelOutput: GatewayStructuredResponse = await callGateway(prompt);

    const claimCheck: { ok: true } | { ok: false; reason: string } = verifyClaims(
      modelOutput,
      groundingFacts,
    );
    if (!claimCheck.ok) {
      return {
        ok: false,
        error: {
          code: "claim_verification_failed",
          message: claimCheck.reason,
        },
      } as HandlerResult;
    }

    const createdAt: string = nowIso();
    const factsJson: string = JSON.stringify(groundingFacts);
    const contentHash: string = stableHash(
      JSON.stringify({
        title: modelOutput.title,
        body_markdown: modelOutput.body_markdown,
        claims: modelOutput.claims,
        facts_hash: stableHash(factsJson),
      }),
    );

    return {
      ok: true,
      data: {
        autonomy: "human_review",
        mutation: "soc2_policy_versions.insert",
        status: "in_review",
        row: {
          organization_id: organizationId,
          policy_type: policyType,
          title: modelOutput.title,
          body_markdown: modelOutput.body_markdown,
          claims_json: modelOutput.claims,
          grounding_facts_json: groundingFacts,
          content_hash_sha256: contentHash,
          trigger,
          requested_by_user_id: requestedByUserId,
          created_at: createdAt,
        },
      },
    } as HandlerResult;
  } catch (error: unknown) {
    const message: string =
      error instanceof Error ? error.message : "unexpected_generate_grounded_policy_error";
    return {
      ok: false,
      error: {
        code: "generate_grounded_policy_failed",
        message,
      },
    } as HandlerResult;
  }
}
