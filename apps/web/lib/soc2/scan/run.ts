import { sql } from "@vercel/postgres";
import { computeCoverageScore } from "@/lib/soc2/scan/score";
import { trackScanCompleted, trackScanStarted } from "@/lib/soc2/scan/access";

type RuleRow = {
  rule_id: string;
  control_id: string;
  title: string;
  description: string;
  provider: string;
  resource_type: string;
  severity: string;
};

type ArtifactRow = {
  artifact_id: string | null;
  status: string | null;
  json_path: string | null;
  excerpt: unknown;
};

function toFindingStatus(status: string | null): "compliant" | "deficient" | "not_assessed" {
  if (status === "pass" || status === "compliant") return "compliant";
  if (status === "fail" || status === "deficient") return "deficient";
  return "not_assessed";
}

export async function runSoc2GapScan(organizationId: string, initiatedBy: string): Promise<string> {
  const started = await sql<{ id: string }>`
    INSERT INTO soc2_gap_scans (organization_id, initiated_by, status)
    VALUES (${organizationId}, ${initiatedBy}, 'running')
    RETURNING id
  `;
  const scanId = started.rows[0].id;

  await trackScanStarted(organizationId, scanId);

  const rules = await sql<RuleRow>`
    SELECT
      r.id AS rule_id,
      r.control_id,
      r.title,
      r.description,
      r.provider,
      r.resource_type,
      r.severity
    FROM soc2_check_rules r
    WHERE r.organization_id = ${organizationId}
    ORDER BY r.sort_order ASC, r.created_at ASC
  `;

  const scoreInput: Array<{ status: string; severity: string }> = [];

  for (const rule of rules.rows) {
    const artifact = await sql<ArtifactRow>`
      SELECT
        a.id AS artifact_id,
        a.status,
        a.json_path,
        a.excerpt
      FROM soc2_evidence_artifacts a
      WHERE a.organization_id = ${organizationId}
        AND a.rule_id = ${rule.rule_id}
      ORDER BY a.updated_at DESC
      LIMIT 1
    `;

    const row = artifact.rows[0];
    const findingStatus = toFindingStatus(row?.status ?? null);
    const evidenceLink = row?.artifact_id ? `/artifact/${row.artifact_id}` : null;

    scoreInput.push({ status: findingStatus, severity: rule.severity });

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
        ${organizationId},
        ${scanId},
        ${rule.control_id},
        ${rule.rule_id},
        ${row?.artifact_id ?? null},
        ${findingStatus},
        ${rule.severity},
        ${rule.title},
        ${rule.description},
        ${rule.provider},
        ${rule.resource_type},
        ${evidenceLink},
        ${JSON.stringify(row?.excerpt ?? {})}::jsonb
      )
    `;
  }

  const breakdown = computeCoverageScore(scoreInput);

  await sql`
    UPDATE soc2_gap_scans
    SET
      status = 'completed',
      score = ${breakdown.score},
      findings_total = ${breakdown.findingsTotal},
      compliant_count = ${breakdown.compliantCount},
      deficient_count = ${breakdown.deficientCount},
      not_assessed_count = ${breakdown.notAssessedCount},
      summary = ${JSON.stringify({
        disclaimer: "Preparatory tool, not an audit opinion.",
      })}::jsonb,
      completed_at = now(),
      updated_at = now()
    WHERE id = ${scanId}
      AND organization_id = ${organizationId}
  `;

  await trackScanCompleted(organizationId, scanId, breakdown.score);

  return scanId;
}
