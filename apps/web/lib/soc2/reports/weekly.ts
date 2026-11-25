import { Pool } from "pg";
import { estimateWeeksToAuditReady } from "@/lib/soc2/reports/readiness";

export interface WeeklyReportListItem {
  id: string;
  createdAt: string;
  score: number;
  scoreDelta: number;
  newlyDeficientCount: number;
  resolvedCount: number;
  readinessWeeks: number;
}

function getPool(): Pool {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return new Pool({ connectionString: databaseUrl });
}

export async function listWeeklyReports(organizationId: string): Promise<WeeklyReportListItem[]> {
  const pool = getPool();
  const result = await pool.query(
    `
    SELECT id, created_at, score, score_delta, newly_deficient_count, resolved_count, readiness_weeks
    FROM soc2_gap_reports
    WHERE organization_id = $1
    ORDER BY created_at DESC
    LIMIT 24
    `,
    [organizationId],
  );
  await pool.end();
  return result.rows.map((row) => ({
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    score: Number(row.score ?? 0),
    scoreDelta: Number(row.score_delta ?? 0),
    newlyDeficientCount: Number(row.newly_deficient_count ?? 0),
    resolvedCount: Number(row.resolved_count ?? 0),
    readinessWeeks: Number(row.readiness_weeks ?? 0),
  }));
}

export async function computeReadinessFromTasks(organizationId: string): Promise<number> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT severity, status, not_applicable FROM soc2_remediation_tasks WHERE organization_id = $1`,
    [organizationId],
  );
  await pool.end();
  return estimateWeeksToAuditReady(
    result.rows.map((r) => ({
      severity: (r.severity ?? "medium") as "low" | "medium" | "high" | "critical",
      status: (r.status ?? "todo") as "todo" | "in_progress" | "verified",
      notApplicable: Boolean(r.not_applicable),
    })),
  );
}
