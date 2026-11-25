import { Pool } from "pg";

export interface RemediationTask {
  id: string;
  title: string;
  severity: string;
  priority: number;
  status: "todo" | "in_progress" | "verified";
  dueAt: string | null;
  assigneeUserId: string | null;
  notApplicable: boolean;
  notApplicableReason: string | null;
}

function getPool(): Pool {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return new Pool({ connectionString: databaseUrl });
}

export async function listRemediationTasks(organizationId: string): Promise<RemediationTask[]> {
  const pool = getPool();
  const result = await pool.query(
    `
    SELECT
      id, title, severity, priority, status, due_at, assignee_user_id,
      not_applicable, not_applicable_reason
    FROM soc2_remediation_tasks
    WHERE organization_id = $1
    ORDER BY
      CASE status WHEN 'todo' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
      priority ASC,
      updated_at DESC
    `,
    [organizationId],
  );
  await pool.end();
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    severity: row.severity,
    priority: Number(row.priority ?? 100),
    status: row.status,
    dueAt: row.due_at ? new Date(row.due_at).toISOString() : null,
    assigneeUserId: row.assignee_user_id ?? null,
    notApplicable: Boolean(row.not_applicable),
    notApplicableReason: row.not_applicable_reason ?? null,
  }));
}

export async function markTaskNotApplicable(
  organizationId: string,
  taskId: string,
  reason: string,
  actorUserId: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `
    UPDATE soc2_remediation_tasks
    SET
      not_applicable = true,
      not_applicable_reason = $1,
      not_applicable_marked_by = $2,
      not_applicable_marked_at = now(),
      updated_at = now()
    WHERE organization_id = $3 AND id = $4
    `,
    [reason, actorUserId, organizationId, taskId],
  );
  await pool.end();
}
