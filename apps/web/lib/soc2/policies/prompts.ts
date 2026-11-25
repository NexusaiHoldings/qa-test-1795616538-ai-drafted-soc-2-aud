/**
 * SOC 2 grounded-policy prompt templates + output lint (F1-005).
 *
 * Server-only, pure (no I/O). The GENERATIVE layer is only allowed to DESCRIBE
 * controls the deterministic mapper already marked present — so every prompt is
 * constrained to the pre-computed grounding facts table and is lint-blocked from
 * the words 'certified', 'attest' and 'opinion' (a drafting tool must never
 * imply an auditor's attestation/opinion; that is legal sign-off territory, per
 * the liability_assessor). generate.ts builds the final prompt from these parts
 * and consistency.ts re-runs the same lint over the model output.
 */

import type { GroundingFact } from "@/lib/soc2/policies/grounding";

/** The five core SOC 2 policy suites in MVP scope (ceo_briefing / objective). */
export type PolicyType =
  | "access_control_policy"
  | "change_management_policy"
  | "incident_response_policy"
  | "vendor_management_policy"
  | "system_operations_policy";

export const POLICY_TYPES: PolicyType[] = [
  "access_control_policy",
  "change_management_policy",
  "incident_response_policy",
  "vendor_management_policy",
  "system_operations_policy",
];

/** Human-facing metadata for each policy type (drives the document grid). */
export interface PolicyTypeMeta {
  type: PolicyType;
  label: string;
  /** Short description shown under the title on the grid. */
  blurb: string;
  /** Control families this policy primarily draws on (for prompt focus). */
  families: string[];
}

export const POLICY_TYPE_META: Record<PolicyType, PolicyTypeMeta> = {
  access_control_policy: {
    type: "access_control_policy",
    label: "Access Control Policy",
    blurb: "How identities, authentication and least-privilege are enforced in your infrastructure.",
    families: ["CC6", "CC1"],
  },
  change_management_policy: {
    type: "change_management_policy",
    label: "Change Management Policy",
    blurb: "How production code changes are reviewed, approved and auditable.",
    families: ["CC8"],
  },
  incident_response_policy: {
    type: "incident_response_policy",
    label: "Incident Response Policy",
    blurb: "How security events are detected, logged and responded to.",
    families: ["CC7"],
  },
  vendor_management_policy: {
    type: "vendor_management_policy",
    label: "Vendor Management Policy",
    blurb: "How third-party cloud and code-hosting providers are governed.",
    families: ["CC6", "CC7"],
  },
  system_operations_policy: {
    type: "system_operations_policy",
    label: "System Operations Policy",
    blurb: "How audit logging integrity and continuous configuration monitoring operate.",
    families: ["CC7", "CC5"],
  },
};

/** Terms the generated prose must never contain (case-insensitive, word-ish). */
export const FORBIDDEN_TERMS: string[] = ["certified", "attest", "opinion"];

/** Return the lowercased forbidden terms that appear anywhere in `text`. */
export function findForbiddenTerms(text: string): string[] {
  if (!text) return [];
  const haystack = text.toLowerCase();
  const hits = new Set<string>();
  for (const term of FORBIDDEN_TERMS) {
    // Match the stem so 'certified'/'certification', 'attest'/'attestation',
    // 'opinion'/'opinions' are all caught.
    if (haystack.includes(term)) hits.add(term);
  }
  return [...hits];
}

/** True when the text is clean of every forbidden attestation term. */
export function isLintClean(text: string): boolean {
  return findForbiddenTerms(text).length === 0;
}

/** Render the canonical grounding facts as a compact, model-readable table. */
export function renderFactsTable(facts: GroundingFact[]): string {
  if (facts.length === 0) return "(no present controls — nothing to describe)";
  return facts
    .map(
      (f) =>
        `control=${f.controlRef} (${f.controlTitle}) | artifact=${f.artifactId} | ${f.factKey}=${f.factValueText}`,
    )
    .join("\n");
}

/** Compact, per-artifact citation key list the model is allowed to cite. */
export function renderAllowedCitations(facts: GroundingFact[]): string {
  const seen = new Map<string, string>();
  for (const f of facts) {
    if (!seen.has(f.artifactId)) {
      seen.set(f.artifactId, `${f.controlRef} — ${f.ruleTitle}`);
    }
  }
  return [...seen.entries()].map(([id, label]) => `${id} :: ${label}`).join("\n");
}

/** The system instruction — identical for every policy type (shared grounding). */
export const SYSTEM_PROMPT: string = [
  "You are a SOC 2 policy drafting assistant for a software company.",
  "You draft practical, audit-friendly policy prose ONLY from the provided grounding facts.",
  "HARD RULES:",
  "1. Never invent controls, tools, artifacts or facts that are not in the grounding facts table.",
  "2. Every entry in `claims` MUST cite exactly one artifact_id that appears in the allowed-citation list.",
  "3. Describe only controls that are present; do not speculate about controls the company does not have.",
  "4. NEVER use the words 'certified', 'attest', or 'opinion' (or their variants). This is a drafting",
  "   aid, not an auditor's attestation. Approval and sign-off are performed by the company's legal team.",
  "5. Return a single JSON object with keys: title, summary, markdown_body, claims.",
  "   `markdown_body` is the full policy in Markdown. `claims` is an array of",
  "   { statement, artifact_id } objects, one per factual assertion that depends on evidence.",
].join("\n");

/** Per-policy-type guidance paragraph woven into the user prompt. */
const POLICY_GUIDANCE: Record<PolicyType, string> = {
  access_control_policy:
    "Cover identity lifecycle, authentication (MFA), least-privilege / IAM roles, key management and " +
    "how access to production data is bounded. Ground each statement in the present access controls.",
  change_management_policy:
    "Cover how code changes reach production: branch protection, mandatory review, and the auditable " +
    "trail of merges. Ground each statement in the present change controls.",
  incident_response_policy:
    "Cover detection, audit-log integrity, triage and response. Ground each statement in the present " +
    "logging and monitoring controls.",
  vendor_management_policy:
    "Cover governance of the cloud (AWS) and code-hosting (GitHub) providers the company depends on, " +
    "and the controls that constrain how those vendors are configured. Ground each statement in facts.",
  system_operations_policy:
    "Cover continuous configuration monitoring, audit logging and operational oversight of the " +
    "infrastructure. Ground each statement in the present system-operations controls.",
};

export interface BuildPromptInput {
  organizationId: string;
  policyType: PolicyType;
  facts: GroundingFact[];
  /** Optional reviewer feedback from a prior 'changes_requested' decision. */
  revisionNote?: string | null;
}

/** Assemble the full user prompt for one policy type from the shared facts. */
export function buildUserPrompt(input: BuildPromptInput): string {
  const meta = POLICY_TYPE_META[input.policyType];
  const guidance = POLICY_GUIDANCE[input.policyType];
  const lines: string[] = [
    `Draft the "${meta.label}" for organization ${input.organizationId}.`,
    `Primary control families: ${meta.families.join(", ")}.`,
    guidance,
  ];
  if (input.revisionNote && input.revisionNote.trim().length > 0) {
    lines.push(
      `A reviewer requested changes on the previous draft. Address this feedback: ${input.revisionNote.trim()}`,
    );
  }
  lines.push(
    "",
    "Allowed citations (artifact_id :: control — rule). You may ONLY cite these artifact_ids:",
    renderAllowedCitations(input.facts),
    "",
    "Grounding facts (control -> artifact -> fact):",
    renderFactsTable(input.facts),
    "",
    "Remember: every claim cites one allowed artifact_id; no forbidden attestation language.",
  );
  return lines.join("\n");
}
