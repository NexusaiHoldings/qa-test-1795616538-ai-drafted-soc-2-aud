/**
 * SOC 2 canonical grounding-context assembler (F1-005).
 *
 * Server-only. This is the deterministic bridge between the two architectural
 * layers: it assembles ONE canonical facts table per organization from
 * `soc2_snapshots` + `soc2_control_evidence_links` (joined through the evidence
 * artifacts, check rules and controls the mapper already evaluated). Only
 * controls the deterministic mapper marked PRESENT (pass / compliant) contribute
 * facts — the generative layer may describe these facts but can never cite an
 * artifact that is not in this set.
 *
 * Because all five policies are generated from the SAME pre-computed facts, they
 * cite identical facts — the concrete mitigation for feasibility risk #3
 * (long-context cross-document consistency in a generated policy suite).
 *
 * Uses the shared pg pool pattern (pg is a server-external package); every query
 * is parameterized ($1, $2, …) — never string interpolation.
 */

import { getScanPool } from "@/lib/soc2/scan/access";
import type { PolicyType } from "@/lib/soc2/policies/prompts";

interface Pool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
}

/** One grounded fact: a present control's evidence artifact + its excerpt. */
export interface GroundingFact {
  artifactId: string;
  controlRef: string;
  controlTitle: string;
  ruleKey: string;
  ruleTitle: string;
  factKey: string;
  factValue: unknown;
  factValueText: string;
  sha256: string;
  snapshotId: string | null;
  provider: string;
  resourceType: string;
  jsonPath: string;
  collectedAt: string | null;
  status: string;
}

/** The canonical grounding context for one organization. */
export interface GroundingContext {
  organizationId: string;
  facts: GroundingFact[];
  allowedArtifactIds: Set<string>;
  /** artifact_id -> sha256 at assembly time (drives the stale-policy check). */
  artifactHashes: Record<string, string>;
  latestSnapshotId: string | null;
  factsTable: string;
}

interface FactSqlRow {
  artifact_id: string;
  control_key: string | null;
  control_title: string | null;
  rule_key: string | null;
  rule_title: string | null;
  sha256: string | null;
  snapshot_id: string | null;
  provider: string | null;
  resource_type: string | null;
  json_path: string | null;
  excerpt: unknown;
  artifact_status: string | null;
  collected_at: string | null;
}

/** Render a fact value compactly for the constrained prompt (bounded length). */
function renderFactValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = "";
    }
  }
  return text.length > 400 ? `${text.slice(0, 397)}…` : text;
}

/**
 * Resolve the id of the most recent snapshot for an organization — pins the
 * generated policy to the point-in-time evidence it was grounded on.
 */
async function loadLatestSnapshotId(pool: Pool, organizationId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT id
       FROM soc2_snapshots
      WHERE organization_id = $1
      ORDER BY collected_at DESC
      LIMIT 1`,
    [organizationId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  return row?.id ? String(row.id) : null;
}

/**
 * Assemble the canonical grounding context for an organization. Reads the
 * deterministic control-evidence links and keeps only PRESENT controls, so the
 * model is handed facts it may phrase but never contradict.
 */
export async function assembleGroundingContext(
  organizationId: string,
  pool: Pool = getScanPool(),
): Promise<GroundingContext> {
  const { rows } = await pool.query(
    `SELECT
        l.artifact_id   AS artifact_id,
        c.control_key   AS control_key,
        c.title         AS control_title,
        r.rule_key      AS rule_key,
        r.title         AS rule_title,
        a.sha256        AS sha256,
        a.snapshot_id   AS snapshot_id,
        a.provider      AS provider,
        a.resource_type AS resource_type,
        a.json_path     AS json_path,
        a.excerpt       AS excerpt,
        a.status        AS artifact_status,
        a.collected_at  AS collected_at
       FROM soc2_control_evidence_links l
       JOIN soc2_controls c
         ON c.id = l.control_id AND c.organization_id = l.organization_id
       JOIN soc2_check_rules r
         ON r.id = l.rule_id AND r.organization_id = l.organization_id
       JOIN soc2_evidence_artifacts a
         ON a.id = l.artifact_id AND a.organization_id = l.organization_id
      WHERE l.organization_id = $1
        AND l.artifact_id IS NOT NULL
        AND (l.status IN ('pass', 'compliant') OR a.status IN ('pass', 'compliant'))
      ORDER BY c.control_key ASC, r.rule_key ASC`,
    [organizationId],
  );

  const facts: GroundingFact[] = [];
  const allowedArtifactIds = new Set<string>();
  const artifactHashes: Record<string, string> = {};

  for (const raw of rows as FactSqlRow[]) {
    const artifactId = raw.artifact_id ? String(raw.artifact_id) : "";
    if (!artifactId) continue;
    const sha256 = raw.sha256 ? String(raw.sha256) : "";
    const fact: GroundingFact = {
      artifactId,
      controlRef: raw.control_key ? String(raw.control_key) : "n/a",
      controlTitle: raw.control_title ? String(raw.control_title) : "",
      ruleKey: raw.rule_key ? String(raw.rule_key) : "",
      ruleTitle: raw.rule_title ? String(raw.rule_title) : "",
      factKey: raw.rule_key ? String(raw.rule_key) : "evidence",
      factValue: raw.excerpt ?? {},
      factValueText: renderFactValue(raw.excerpt ?? {}),
      sha256,
      snapshotId: raw.snapshot_id ? String(raw.snapshot_id) : null,
      provider: raw.provider ? String(raw.provider) : "",
      resourceType: raw.resource_type ? String(raw.resource_type) : "",
      jsonPath: raw.json_path ? String(raw.json_path) : "",
      collectedAt: raw.collected_at ? String(raw.collected_at) : null,
      status: raw.artifact_status ? String(raw.artifact_status) : "pass",
    };
    facts.push(fact);
    allowedArtifactIds.add(artifactId);
    if (sha256) artifactHashes[artifactId] = sha256;
  }

  const latestSnapshotId = await loadLatestSnapshotId(pool, organizationId);
  const factsTable = facts
    .map(
      (f) =>
        `control=${f.controlRef} (${f.controlTitle}) | artifact=${f.artifactId} | ${f.factKey}=${f.factValueText}`,
    )
    .join("\n");

  return {
    organizationId,
    facts,
    allowedArtifactIds,
    artifactHashes,
    latestSnapshotId,
    factsTable,
  };
}

/** True when an organization has at least one present control to ground on. */
export async function hasGroundingFacts(
  organizationId: string,
  pool: Pool = getScanPool(),
): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `SELECT 1
         FROM soc2_control_evidence_links l
         JOIN soc2_evidence_artifacts a
           ON a.id = l.artifact_id AND a.organization_id = l.organization_id
        WHERE l.organization_id = $1
          AND l.artifact_id IS NOT NULL
          AND (l.status IN ('pass', 'compliant') OR a.status IN ('pass', 'compliant'))
        LIMIT 1`,
      [organizationId],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Persist the canonical facts for one organization + policy_type into
 * `soc2_grounding_facts` so the agent-tool path and the UI path share identical
 * grounding. Replaces the prior set for that (org, policy_type) atomically per
 * row via upsert. Best-effort for the UI flow — a persistence failure must not
 * block drafting since the in-memory context already holds the facts.
 */
export async function persistGroundingFacts(
  organizationId: string,
  policyType: PolicyType,
  facts: GroundingFact[],
  pool: Pool = getScanPool(),
): Promise<void> {
  // Clear stale rows for this policy type, then re-insert the current facts.
  await pool.query(
    `DELETE FROM soc2_grounding_facts WHERE organization_id = $1 AND policy_type = $2`,
    [organizationId, policyType],
  );
  for (const fact of facts) {
    await pool.query(
      `INSERT INTO soc2_grounding_facts
         (organization_id, policy_type, artifact_id, control_ref, fact_key,
          fact_value, snapshot_id, sha256)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       ON CONFLICT (organization_id, policy_type, artifact_id, fact_key)
       DO UPDATE SET fact_value = EXCLUDED.fact_value,
                     snapshot_id = EXCLUDED.snapshot_id,
                     sha256 = EXCLUDED.sha256`,
      [
        organizationId,
        policyType,
        fact.artifactId,
        fact.controlRef,
        fact.factKey,
        JSON.stringify(fact.factValue ?? {}),
        fact.snapshotId,
        fact.sha256 || null,
      ],
    );
  }
}
