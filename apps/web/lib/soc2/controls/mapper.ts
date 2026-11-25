/**
 * SOC 2 evidence mapper — deterministic snapshot → control wiring (F1-003).
 *
 * Server-only. Reads the latest soc2_snapshots per (provider, resource_type),
 * runs each catalog rule's PURE evaluator (checks.ts — no model), and writes the
 * deterministic evidence trail:
 *
 *   - soc2_evidence_artifacts      — one row per rule: the snapshot id, the exact
 *                                    JSON path that fired, a sha256 integrity
 *                                    hash of the source snapshot, and the raw
 *                                    JSON excerpt for the "why this fired" view.
 *   - soc2_control_evidence_links  — the rule → control → artifact link carrying
 *                                    the pass/fail verdict.
 *   - soc2_check_rules.status      — the per-rule verdict + rationale.
 *   - soc2_controls.status         — the rolled-up control verdict.
 *
 * This is the layer "the LLM cannot override": the generative policy layer may
 * only describe controls this mapper has already marked present. Uses the same
 * externalized `pg` pool pattern as snapshot.ts; all queries are parameterized.
 */

import { evaluateRule, type RuleEvaluation } from "@/lib/soc2/controls/checks";
import type { ControlStatus, RuleStatus } from "@/lib/soc2/controls/catalog";

interface Pool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pool: any = null;

function getPool(): Pool {
  if (_pool) return _pool;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (config: Record<string, unknown>) => Pool;
  };
  _pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

function parseContent(raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

interface LatestSnapshot {
  id: string;
  provider: string;
  resourceType: string;
  content: unknown;
  contentHash: string;
  collectedAt: string;
}

interface RuleRecord {
  id: string;
  controlId: string;
  ruleKey: string;
  provider: string;
  resourceType: string;
}

export interface MappingSummary {
  evaluated: number;
  passed: number;
  failed: number;
  notEvaluated: number;
  controlsCompliant: number;
  controlsDeficient: number;
}

/** Load the most-recent snapshot per (provider, resource_type) for an org. */
async function loadLatestSnapshots(
  pool: Pool,
  organizationId: string,
): Promise<Map<string, LatestSnapshot>> {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (provider, resource_type)
            id, provider, resource_type, content, content_hash, collected_at
       FROM soc2_snapshots
      WHERE organization_id = $1
      ORDER BY provider, resource_type, collected_at DESC`,
    [organizationId],
  );
  const map = new Map<string, LatestSnapshot>();
  for (const row of rows as Record<string, unknown>[]) {
    const provider = String(row.provider);
    const resourceType = String(row.resource_type);
    map.set(`${provider}:${resourceType}`, {
      id: String(row.id),
      provider,
      resourceType,
      content: parseContent(row.content),
      contentHash: String(row.content_hash ?? ""),
      collectedAt: String(row.collected_at ?? ""),
    });
  }
  return map;
}

/** Load every catalog rule for an org from soc2_check_rules. */
async function loadRules(pool: Pool, organizationId: string): Promise<RuleRecord[]> {
  const { rows } = await pool.query(
    `SELECT id, control_id, rule_key, provider, resource_type
       FROM soc2_check_rules
      WHERE organization_id = $1`,
    [organizationId],
  );
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    controlId: String(r.control_id),
    ruleKey: String(r.rule_key),
    provider: String(r.provider),
    resourceType: String(r.resource_type),
  }));
}

/**
 * Persist one rule's result: upsert the evidence artifact, link it to its
 * control, and update the rule row. Returns the artifact id (null when there was
 * no snapshot to evaluate). All writes are keyed on (org, rule) so re-running the
 * mapper overwrites the current verdict rather than accumulating rows.
 */
async function persistRuleResult(
  pool: Pool,
  organizationId: string,
  rule: RuleRecord,
  snapshot: LatestSnapshot | undefined,
  evaluation: RuleEvaluation | null,
): Promise<{ status: RuleStatus; artifactId: string | null }> {
  // No snapshot for this rule's resource type → not yet evaluated.
  if (!snapshot || !evaluation) {
    await pool.query(
      `UPDATE soc2_check_rules
          SET status = 'not_evaluated', rationale = $2, evaluated_at = NULL, updated_at = now()
        WHERE id = $1`,
      [
        rule.id,
        snapshot
          ? "No deterministic evaluator is registered for this rule."
          : `No ${rule.provider} ${rule.resourceType} snapshot has been collected yet.`,
      ],
    );
    await pool.query(
      `INSERT INTO soc2_control_evidence_links
         (organization_id, control_id, rule_id, artifact_id, status, updated_at)
       VALUES ($1, $2, $3, NULL, 'not_evaluated', now())
       ON CONFLICT (organization_id, rule_id) DO UPDATE SET
         control_id = EXCLUDED.control_id,
         artifact_id = NULL,
         status = 'not_evaluated',
         updated_at = now()`,
      [organizationId, rule.controlId, rule.id],
    );
    return { status: "not_evaluated", artifactId: null };
  }

  const artifactRes = await pool.query(
    `INSERT INTO soc2_evidence_artifacts
       (organization_id, rule_id, snapshot_id, provider, resource_type, json_path,
        sha256, status, excerpt, collected_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, now())
     ON CONFLICT (organization_id, rule_id) DO UPDATE SET
       snapshot_id = EXCLUDED.snapshot_id,
       provider = EXCLUDED.provider,
       resource_type = EXCLUDED.resource_type,
       json_path = EXCLUDED.json_path,
       sha256 = EXCLUDED.sha256,
       status = EXCLUDED.status,
       excerpt = EXCLUDED.excerpt,
       collected_at = EXCLUDED.collected_at,
       updated_at = now()
     RETURNING id`,
    [
      organizationId,
      rule.id,
      snapshot.id,
      snapshot.provider,
      snapshot.resourceType,
      evaluation.jsonPath,
      snapshot.contentHash,
      evaluation.status,
      JSON.stringify(evaluation.excerpt ?? {}),
      snapshot.collectedAt || null,
    ],
  );
  const artifactId = String((artifactRes.rows[0] as Record<string, unknown>).id);

  await pool.query(
    `UPDATE soc2_check_rules
        SET status = $2, rationale = $3, evaluated_at = now(), updated_at = now()
      WHERE id = $1`,
    [rule.id, evaluation.status, evaluation.rationale],
  );

  await pool.query(
    `INSERT INTO soc2_control_evidence_links
       (organization_id, control_id, rule_id, artifact_id, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (organization_id, rule_id) DO UPDATE SET
       control_id = EXCLUDED.control_id,
       artifact_id = EXCLUDED.artifact_id,
       status = EXCLUDED.status,
       updated_at = now()`,
    [organizationId, rule.controlId, rule.id, artifactId, evaluation.status],
  );

  return { status: evaluation.status, artifactId };
}

/** Roll a control's rule verdicts up into a single control status. */
export function rollUpControlStatus(statuses: RuleStatus[]): ControlStatus {
  if (statuses.length === 0) return "not_started";
  if (statuses.some((s) => s === "fail")) return "deficient";
  if (statuses.every((s) => s === "not_evaluated")) return "not_started";
  if (statuses.every((s) => s === "pass")) return "compliant";
  return "in_progress";
}

/**
 * Run the full deterministic mapping for an organization. Idempotent: loads the
 * latest snapshots, evaluates every catalog rule purely, overwrites the current
 * evidence artifacts + links, and recomputes each control's rolled-up status.
 */
export async function runMapping(organizationId: string): Promise<MappingSummary> {
  const pool = getPool();
  const summary: MappingSummary = {
    evaluated: 0,
    passed: 0,
    failed: 0,
    notEvaluated: 0,
    controlsCompliant: 0,
    controlsDeficient: 0,
  };

  let snapshots: Map<string, LatestSnapshot>;
  let rules: RuleRecord[];
  try {
    snapshots = await loadLatestSnapshots(pool, organizationId);
    rules = await loadRules(pool, organizationId);
  } catch {
    // No DB / no catalog yet — nothing to map.
    return summary;
  }

  const statusesByControl = new Map<string, RuleStatus[]>();
  for (const rule of rules) {
    const snapshot = snapshots.get(`${rule.provider}:${rule.resourceType}`);
    const evaluation = snapshot ? evaluateRule(rule.ruleKey, snapshot.content) : null;
    let status: RuleStatus = "not_evaluated";
    try {
      const result = await persistRuleResult(pool, organizationId, rule, snapshot, evaluation);
      status = result.status;
    } catch {
      status = "not_evaluated";
    }

    if (status === "pass") summary.passed += 1;
    else if (status === "fail") summary.failed += 1;
    else summary.notEvaluated += 1;
    if (status !== "not_evaluated") summary.evaluated += 1;

    const list = statusesByControl.get(rule.controlId) ?? [];
    list.push(status);
    statusesByControl.set(rule.controlId, list);
  }

  // Roll each control's rule verdicts up and persist the control status.
  for (const [controlId, statuses] of statusesByControl.entries()) {
    const controlStatus = rollUpControlStatus(statuses);
    if (controlStatus === "compliant") summary.controlsCompliant += 1;
    if (controlStatus === "deficient") summary.controlsDeficient += 1;
    const anyEvaluated = statuses.some((s) => s !== "not_evaluated");
    try {
      await pool.query(
        `UPDATE soc2_controls
            SET status = $2,
                evaluated_at = CASE WHEN $3 THEN now() ELSE evaluated_at END,
                updated_at = now()
          WHERE id = $1`,
        [controlId, controlStatus, anyEvaluated],
      );
    } catch {
      /* best-effort per control */
    }
  }

  return summary;
}
