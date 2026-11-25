/**
 * SOC 2 free gap scan runner (F1-004).
 *
 * Server-only. The PLG front door: after a CTO connects AWS + GitHub, this
 * executes the full DETERMINISTIC control layer and materializes a point-in-time
 * scan:
 *
 *   1. INSERT a soc2_gap_scans row (status 'running') + emit scan_started.
 *   2. runMapping(org) — re-evaluate every catalog check rule PURELY over the
 *      latest snapshots (no model in the loop) so the evidence artifacts reflect
 *      current state. This is the layer "the LLM cannot override".
 *   3. Read every rule joined to its evidence artifact and write one soc2_findings
 *      row per control rule (status, severity, evidence link, raw excerpt).
 *   4. computeCoverageScore() — a severity-weighted 0-100 score that treats
 *      unassessed criteria as NOT compliant (never inflates readiness).
 *   5. UPDATE the scan row to 'completed' with the score + counts + emit
 *      scan_completed.
 *
 * Uses the shared pg pool from access.ts; every query is parameterized.
 */

import { runMapping } from "@/lib/soc2/controls/mapper";
import { computeCoverageScore, type ScoreInputFinding } from "@/lib/soc2/scan/score";
import { getScanPool, trackScanCompleted, trackScanStarted } from "@/lib/soc2/scan/access";

interface RuleArtifactRow {
  rule_id: string;
  control_id: string;
  title: string;
  description: string;
  provider: string;
  resource_type: string;
  severity: string;
  rule_rationale: string | null;
  artifact_id: string | null;
  artifact_status: string | null;
  excerpt: unknown;
}

export type FindingStatus = "compliant" | "deficient" | "not_assessed";

/** Map a deterministic rule/artifact verdict onto a finding status. */
function toFindingStatus(status: string | null | undefined): FindingStatus {
  if (status === "pass" || status === "compliant") return "compliant";
  if (status === "fail" || status === "deficient") return "deficient";
  return "not_assessed";
}

function excerptJson(raw: unknown): string {
  if (raw && typeof raw === "object") return JSON.stringify(raw);
  if (typeof raw === "string" && raw.trim().length > 0) {
    try {
      return JSON.stringify(JSON.parse(raw));
    } catch {
      return JSON.stringify({ text: raw });
    }
  }
  return JSON.stringify({});
}

/**
 * Run a full gap scan for an organization and return the new scan id. Idempotent
 * per call (each invocation creates a fresh scan row); safe to call from a Server
 * Action or a Vercel cron handler.
 */
export async function runSoc2GapScan(organizationId: string, initiatedBy: string | null): Promise<string> {
  const pool = getScanPool();

  const created = await pool.query(
    `INSERT INTO soc2_gap_scans (organization_id, initiated_by, status)
     VALUES ($1, $2, 'running')
     RETURNING id`,
    [organizationId, initiatedBy],
  );
  const scanId = String((created.rows[0] as Record<string, unknown>).id);

  await trackScanStarted(organizationId, scanId, initiatedBy);

  // Re-run the deterministic evidence mapper so artifacts reflect current state.
  try {
    await runMapping(organizationId);
  } catch {
    // Mapping is best-effort (e.g. no snapshots yet); findings fall back to
    // 'not_assessed' rather than failing the whole scan.
  }

  const { rows } = await pool.query(
    `SELECT
        r.id            AS rule_id,
        r.control_id    AS control_id,
        r.title         AS title,
        r.description   AS description,
        r.provider      AS provider,
        r.resource_type AS resource_type,
        r.severity      AS severity,
        r.rationale     AS rule_rationale,
        a.id            AS artifact_id,
        a.status        AS artifact_status,
        a.excerpt       AS excerpt
       FROM soc2_check_rules r
       LEFT JOIN soc2_evidence_artifacts a
         ON a.rule_id = r.id AND a.organization_id = r.organization_id
      WHERE r.organization_id = $1
      ORDER BY r.sort_order ASC, r.created_at ASC`,
    [organizationId],
  );
  const ruleRows = rows as unknown as RuleArtifactRow[];

  const scoreInput: ScoreInputFinding[] = [];

  for (const rule of ruleRows) {
    const findingStatus = toFindingStatus(rule.artifact_status);
    const evidenceLink = `/controls/${rule.control_id}`;
    const rationale = (rule.rule_rationale ?? "").trim() || rule.description || "";

    scoreInput.push({ status: findingStatus, severity: rule.severity });

    await pool.query(
      `INSERT INTO soc2_findings (
         organization_id, scan_id, control_id, rule_id, artifact_id,
         status, severity, title, rationale, provider, resource_type,
         evidence_link, raw_excerpt
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
      [
        organizationId,
        scanId,
        rule.control_id,
        rule.rule_id,
        rule.artifact_id,
        findingStatus,
        rule.severity,
        rule.title,
        rationale,
        rule.provider,
        rule.resource_type,
        rule.artifact_id ? evidenceLink : null,
        excerptJson(rule.excerpt),
      ],
    );
  }

  const breakdown = computeCoverageScore(scoreInput);

  const summary = {
    disclaimer: "Preparatory tool, not an audit opinion.",
    compliant: breakdown.compliantCount,
    deficient: breakdown.deficientCount,
    not_assessed: breakdown.notAssessedCount,
  };

  await pool.query(
    `UPDATE soc2_gap_scans
        SET status = 'completed',
            score = $2,
            findings_total = $3,
            compliant_count = $4,
            deficient_count = $5,
            not_assessed_count = $6,
            summary = $7::jsonb,
            completed_at = now(),
            updated_at = now()
      WHERE id = $1 AND organization_id = $8`,
    [
      scanId,
      breakdown.score,
      breakdown.findingsTotal,
      breakdown.compliantCount,
      breakdown.deficientCount,
      breakdown.notAssessedCount,
      JSON.stringify(summary),
      organizationId,
    ],
  );

  await trackScanCompleted(organizationId, scanId, breakdown.score, initiatedBy);

  return scanId;
}
