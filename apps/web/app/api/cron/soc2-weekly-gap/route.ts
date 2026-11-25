import { NextResponse } from "next/server";
import { Pool } from "pg";
import { estimateWeeksToAuditReady } from "@/lib/soc2/reports/readiness";

export async function GET(): Promise<NextResponse> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL missing" }, { status: 500 });
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const orgs = await pool.query(
      `
      SELECT DISTINCT organization_id
      FROM soc2_gap_scans
      `,
    );

    for (const org of orgs.rows) {
      const organizationId: string = org.organization_id;

      const scanRows = await pool.query(
        `
        SELECT id, score, created_at
        FROM soc2_gap_scans
        WHERE organization_id = $1 AND status = 'completed'
        ORDER BY created_at DESC
        LIMIT 2
        `,
        [organizationId],
      );

      if (scanRows.rowCount === 0) continue;
      const latest = scanRows.rows[0];
      const previous = scanRows.rows[1] ?? null;

      const latestDef = await pool.query(
        `SELECT rule_id FROM soc2_findings WHERE organization_id = $1 AND scan_id = $2 AND status = 'deficient'`,
        [organizationId, latest.id],
      );
      const prevDef = previous
        ? await pool.query(
            `SELECT rule_id FROM soc2_findings WHERE organization_id = $1 AND scan_id = $2 AND status = 'deficient'`,
            [organizationId, previous.id],
          )
        : { rows: [] as Array<{ rule_id: string }> };

      const latestSet = new Set<string>(latestDef.rows.map((r) => r.rule_id));
      const prevSet = new Set<string>(prevDef.rows.map((r) => r.rule_id));

      const newlyDeficient = [...latestSet].filter((id) => !prevSet.has(id));
      const resolved = [...prevSet].filter((id) => !latestSet.has(id));

      for (const ruleId of newlyDeficient) {
        await pool.query(
          `
          INSERT INTO soc2_remediation_tasks (
            organization_id, control_id, rule_id, finding_id, title, description, severity, priority, status, last_deficient_scan_id, updated_at
          )
          SELECT
            f.organization_id, f.control_id, f.rule_id, f.id, f.title, f.rationale, f.severity,
            CASE f.severity WHEN 'critical' THEN 10 WHEN 'high' THEN 20 WHEN 'medium' THEN 40 ELSE 60 END,
            'todo', $3, now()
          FROM soc2_findings f
          WHERE f.organization_id = $1 AND f.scan_id = $2 AND f.rule_id = $4 AND f.status = 'deficient'
          ON CONFLICT (organization_id, rule_id)
          DO UPDATE SET
            finding_id = EXCLUDED.finding_id,
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            severity = EXCLUDED.severity,
            priority = EXCLUDED.priority,
            status = CASE WHEN soc2_remediation_tasks.status = 'verified' THEN 'todo' ELSE soc2_remediation_tasks.status END,
            last_deficient_scan_id = EXCLUDED.last_deficient_scan_id,
            updated_at = now()
          `,
          [organizationId, latest.id, latest.id, ruleId],
        );
      }

      for (const ruleId of resolved) {
        await pool.query(
          `
          UPDATE soc2_remediation_tasks
          SET status = 'verified', verified_scan_id = $1, updated_at = now()
          WHERE organization_id = $2 AND rule_id = $3 AND not_applicable = false
          `,
          [latest.id, organizationId, ruleId],
        );
      }

      const taskRows = await pool.query(
        `SELECT severity, status, not_applicable FROM soc2_remediation_tasks WHERE organization_id = $1`,
        [organizationId],
      );

      const readinessWeeks = estimateWeeksToAuditReady(
        taskRows.rows.map((row) => ({
          severity: (row.severity ?? "medium") as "low" | "medium" | "high" | "critical",
          status: (row.status ?? "todo") as "todo" | "in_progress" | "verified",
          notApplicable: Boolean(row.not_applicable),
        })),
      );

      const score = Number(latest.score ?? 0);
      const previousScore = previous ? Number(previous.score ?? 0) : 0;

      await pool.query(
        `
        INSERT INTO soc2_gap_reports (
          organization_id, scan_id, previous_scan_id, score, previous_score, score_delta,
          newly_deficient_count, resolved_count, summary, readiness_weeks
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
        `,
        [
          organizationId,
          latest.id,
          previous?.id ?? null,
          score,
          previousScore,
          score - previousScore,
          newlyDeficient.length,
          resolved.length,
          JSON.stringify({ run: "weekly_cron" }),
          readinessWeeks,
        ],
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "unknown_error",
      },
      { status: 500 },
    );
  } finally {
    await pool.end();
  }
}
