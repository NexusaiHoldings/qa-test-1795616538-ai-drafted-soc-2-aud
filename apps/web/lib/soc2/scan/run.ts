import { sql } from "@vercel/postgres";
import { computeCoverageScore } from "./score";
import { emitScanCompleted, emitScanStarted } from "./access";

interface RuleRow {
  rule_id: string;
  control_id: string;
  rule_title: string;
  rule_description: string;
  severity: string;
  provider: string;
  resource_type: string;
  status: string;
  rationale: string | null;
  artifact_id: string | null;
  json_path: string | null;
  excerpt: unknown;
}

export async function runGapScan(organizationId: string, userId: string): Promise<{ scanId: string }> {
  const scanInsert = await sql<{
    id: string;
  }>`
    INSERT INTO soc2_gap_scans (organization_id, initiated_by, status)
    VALUES (${organizationId}::uuid, ${userId}::uuid, 'running')
    RETURNING id
  `;
  const scanId = scanInsert.rows[0].id;
  await emitScanStarted(organizationId, userId, scanId);

  try {
    const rules = await sql<RuleRow>`
      SELECT
        r.id AS rule_id,
        r.control_id,
        r.title AS rule_title,
        r.description AS rule_description,
        r.severity,
        r.provider,
        r.resource_type,
        COALESCE(e.status, 'not_assessed') AS status,
        COALESCE(r.rationale, '') AS rationale,
        e.id AS artifact_id,
        e.json_path,
        COALESCE(e.excerpt, '{}'::jsonb) AS excerpt
      FROM soc2_check_rules r
      LEFT JOIN soc2_evidence_artifacts e
        ON e.organization_id = r.organization_id
       AND e.rule_id = r.id
      WHERE r.organization_id = ${organizationId}::uuid
      ORDER BY r.sort_order ASC
    `;

    for (const row of rules.rows) {
      const normalizedStatus =
        row.status === "compliant" || row.status === "deficient" ? row.status : "not_assessed";
      const evidenceLink = row.artifact_id ? `/artifact/${row.artifact_id}` : null;

      await sql`
        INSERT INTO soc2_findings (
          organization_id,
          scan_id,
          control_id,
          rule_id,
          artifact_id,
          status,
          severity,
          title,
          rationale,
          provider,
          resource_type,
          evidence_link,
          raw_excerpt
        ) VALUES (
          ${organizationId}::uuid,
          ${scanId}::uuid,
          ${row.control_id}::uuid,
          ${row.rule_id}::uuid,
          ${row.artifact_id ? `${row.artifact_id}::uuid` : null},
          ${normalizedStatus},
          ${row.severity},
          ${row.rule_title},
          ${row.rationale ?? row.rule_description ?? ""},
          ${row.provider},
          ${row.resource_type},
          ${evidenceLink},
          ${JSON.stringify(row.excerpt ?? {})}::jsonb
        )
      `;
    }

    const findingsRows = await sql<{ status: "compliant" | "deficient" | "not_assessed"; severity: string }>`
      SELECT status, severity
      FROM soc2_findings
      WHERE scan_id = ${scanId}::uuid
    `;

    const scoring = computeCoverageScore(findingsRows.rows);

    await sql`
      UPDATE soc2_gap_scans
      SET
        status = 'completed',
        score = ${scoring.score},
        findings_total = ${scoring.findingsTotal},
        compliant_count = ${scoring.compliantCount},
        deficient_count = ${scoring.deficientCount},
        not_assessed_count = ${scoring.notAssessedCount},
        summary = ${JSON.stringify({
          disclaimer: "Preparatory tool, not an audit opinion.",
        })}::jsonb,
        completed_at = now(),
        updated_at = now()
      WHERE id = ${scanId}::uuid
    `;

    await emitScanCompleted(organizationId, userId, scanId, scoring.score);
    return { scanId };
  } catch (error) {
    await sql`
      UPDATE soc2_gap_scans
      SET status = 'failed', updated_at = now()
      WHERE id = ${scanId}::uuid
    `;
    throw error;
  }
}
