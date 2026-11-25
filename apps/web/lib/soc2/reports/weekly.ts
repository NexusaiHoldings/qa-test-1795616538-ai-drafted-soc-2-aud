import { sql } from "@vercel/postgres";
import { estimateReadinessWeeks } from "./readiness";

type OrgRow = { organization_id: string };

export async function runWeeklyGapReports(): Promise<number> {
  const orgs = await sql<OrgRow>`
    SELECT DISTINCT organization_id
    FROM soc2_connectors
    WHERE status = 'connected'
  `;

  for (const org of orgs.rows) {
    const latest = await sql<{
      id: string;
      score: number;
      deficient_count: number;
      created_at: string;
    }>`
      SELECT id, score, deficient_count, created_at
      FROM soc2_gap_scans
      WHERE organization_id = ${org.organization_id}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (latest.rowCount === 0) continue;

    const previous = await sql<{ id: string; score: number }>`
      SELECT id, score
      FROM soc2_gap_scans
      WHERE organization_id = ${org.organization_id}
        AND id <> ${latest.rows[0].id}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const latestDeficient = await sql<{ rule_id: string; id: string; severity: string; title: string; rationale: string; control_id: string }>`
      SELECT rule_id, id, severity, title, rationale, control_id
      FROM soc2_findings
      WHERE organization_id = ${org.organization_id}
        AND scan_id = ${latest.rows[0].id}
        AND status = 'deficient'
    `;

    const previousDeficient = await sql<{ rule_id: string }>`
      SELECT rule_id
      FROM soc2_findings
      WHERE organization_id = ${org.organization_id}
        AND scan_id = ${previous.rows[0]?.id ?? null}
        AND status = 'deficient'
    `;

    const prevSet = new Set(previousDeficient.rows.map((r) => r.rule_id));
    const currSet = new Set(latestDeficient.rows.map((r) => r.rule_id));
    const newlyDeficient = latestDeficient.rows.filter((r) => !prevSet.has(r.rule_id));
    const resolved = [...prevSet].filter((ruleId) => !currSet.has(ruleId));

    const high = latestDeficient.rows.filter((r) => r.severity === "high").length;
    const medium = latestDeficient.rows.filter((r) => r.severity === "medium").length;
    const low = latestDeficient.rows.filter((r) => r.severity !== "high" && r.severity !== "medium").length;
    const readinessWeeks = estimateReadinessWeeks({
      deficientCount: latest.rows[0].deficient_count,
      highSeverityCount: high,
      mediumSeverityCount: medium,
      lowSeverityCount: low,
    });

    const reportInsert = await sql<{ id: string }>`
      INSERT INTO soc2_gap_reports (
        organization_id, scan_id, previous_scan_id, score, previous_score,
        score_delta, newly_deficient_count, resolved_count, summary, readiness_weeks
      )
      VALUES (
        ${org.organization_id},
        ${latest.rows[0].id},
        ${previous.rows[0]?.id ?? null},
        ${latest.rows[0].score},
        ${previous.rows[0]?.score ?? latest.rows[0].score},
        ${latest.rows[0].score - (previous.rows[0]?.score ?? latest.rows[0].score)},
        ${newlyDeficient.length},
        ${resolved.length},
        ${JSON.stringify({ generatedBy: "cron:soc2-weekly-gap" })}::jsonb,
        ${readinessWeeks}
      )
      RETURNING id
    `;

    const reportId = reportInsert.rows[0]?.id;
    if (reportId) {
      for (const finding of newlyDeficient) {
        await sql`
          INSERT INTO soc2_gap_report_changes (
            organization_id, report_id, rule_id, change_type, previous_status, current_status, finding_id
          ) VALUES (
            ${org.organization_id}, ${reportId}, ${finding.rule_id}, 'newly_deficient', 'compliant', 'deficient', ${finding.id}
          )
        `;
      }
      for (const ruleId of resolved) {
        await sql`
          INSERT INTO soc2_gap_report_changes (
            organization_id, report_id, rule_id, change_type, previous_status, current_status
          ) VALUES (
            ${org.organization_id}, ${reportId}, ${ruleId}, 'resolved', 'deficient', 'compliant'
          )
        `;
      }
    }

    for (const finding of latestDeficient.rows) {
      await sql`
        INSERT INTO soc2_remediation_tasks (
          organization_id, control_id, rule_id, finding_id, title, description, severity, priority, status, last_deficient_scan_id, updated_at
        )
        VALUES (
          ${org.organization_id},
          ${finding.control_id},
          ${finding.rule_id},
          ${finding.id},
          ${finding.title},
          ${finding.rationale ?? ""},
          ${finding.severity},
          ${finding.severity === "high" ? 10 : finding.severity === "medium" ? 50 : 90},
          'todo',
          ${latest.rows[0].id},
          now()
        )
        ON CONFLICT (organization_id, rule_id) DO UPDATE SET
          finding_id = EXCLUDED.finding_id,
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          severity = EXCLUDED.severity,
          priority = EXCLUDED.priority,
          last_deficient_scan_id = EXCLUDED.last_deficient_scan_id,
          status = CASE
            WHEN soc2_remediation_tasks.status = 'verified' THEN 'todo'
            ELSE soc2_remediation_tasks.status
          END,
          verified_scan_id = NULL,
          updated_at = now()
      `;
    }

    for (const ruleId of resolved) {
      await sql`
        UPDATE soc2_remediation_tasks
        SET status = 'verified',
            verified_scan_id = ${latest.rows[0].id},
            updated_at = now()
        WHERE organization_id = ${org.organization_id}
          AND rule_id = ${ruleId}
      `;
    }
  }

  return orgs.rowCount;
}
