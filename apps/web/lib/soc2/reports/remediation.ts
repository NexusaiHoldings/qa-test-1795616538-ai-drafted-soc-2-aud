import { sql } from "@vercel/postgres";

export type RemediationTask = {
  id: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  priority: number;
  dueAt: string | null;
  assigneeUserId: string | null;
  notApplicable: boolean;
  notApplicableReason: string | null;
};

export async function getRemediationTasks(organizationId: string): Promise<RemediationTask[]> {
  const result = await sql<RemediationTask>`
    SELECT
      id, title, description, severity, status, priority,
      due_at as "dueAt",
      assignee_user_id as "assigneeUserId",
      not_applicable as "notApplicable",
      not_applicable_reason as "notApplicableReason"
    FROM soc2_remediation_tasks
    WHERE organization_id = ${organizationId}
    ORDER BY
      CASE status
        WHEN 'todo' THEN 0
        WHEN 'in_progress' THEN 1
        WHEN 'verified' THEN 2
        ELSE 3
      END,
      priority ASC,
      updated_at DESC
  `;
  return result.rows;
}
