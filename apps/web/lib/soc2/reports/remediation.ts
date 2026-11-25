/**
 * Remediation-tracker data + mutations (F1-006).
 *
 * Server-only helpers behind /remediation. The board is a kanban with three
 * columns — To do / In progress / Verified by scan — where the ONLY path into
 * "Verified" is the weekly scan passing the rule (see weekly.ts). Humans may:
 *   - assign an owner (org member),
 *   - set a due date,
 *   - start a task (todo → in_progress) or move it back,
 *   - mark a finding "not applicable" with a justification preserved for the
 *     auditor (and clear it).
 * No mutation here can set status = 'verified' — that is scan-gated by design.
 *
 * Every query is parameterized and scoped by organization_id; the shared `pg`
 * pool is reused from lib/soc2/scan/access.
 */

import { getScanPool } from "@/lib/soc2/scan/access";

export type RemediationStatus = "todo" | "in_progress" | "verified";

export interface RemediationTask {
  id: string;
  controlId: string;
  ruleId: string;
  title: string;
  description: string;
  severity: string;
  status: RemediationStatus;
  priority: number;
  dueAt: string | null;
  assigneeUserId: string | null;
  assigneeEmail: string | null;
  notApplicable: boolean;
  notApplicableReason: string | null;
  notApplicableMarkedAt: string | null;
  verifiedScanId: string | null;
  updatedAt: string;
}

export interface OrgMember {
  userId: string;
  email: string;
  role: string;
}

export interface RemediationBoard {
  todo: RemediationTask[];
  inProgress: RemediationTask[];
  verified: RemediationTask[];
  notApplicable: RemediationTask[];
  members: OrgMember[];
}

interface TaskRow {
  id: string;
  control_id: string;
  rule_id: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  priority: number;
  due_at: string | null;
  assignee_user_id: string | null;
  assignee_email: string | null;
  not_applicable: boolean;
  not_applicable_reason: string | null;
  not_applicable_marked_at: string | null;
  verified_scan_id: string | null;
  updated_at: string;
}

function mapTask(row: TaskRow): RemediationTask {
  const status: RemediationStatus =
    row.status === "in_progress" || row.status === "verified" ? row.status : "todo";
  return {
    id: String(row.id),
    controlId: String(row.control_id),
    ruleId: String(row.rule_id),
    title: row.title,
    description: row.description,
    severity: row.severity,
    status,
    priority: row.priority,
    dueAt: row.due_at,
    assigneeUserId: row.assignee_user_id,
    assigneeEmail: row.assignee_email,
    notApplicable: row.not_applicable,
    notApplicableReason: row.not_applicable_reason,
    notApplicableMarkedAt: row.not_applicable_marked_at,
    verifiedScanId: row.verified_scan_id,
    updatedAt: row.updated_at,
  };
}

/** All remediation tasks for an org, joined to the assignee's email. */
export async function getRemediationTasks(organizationId: string): Promise<RemediationTask[]> {
  const { rows } = await getScanPool().query(
    `SELECT t.id, t.control_id, t.rule_id, t.title, t.description, t.severity,
            t.status, t.priority, t.due_at, t.assignee_user_id,
            u.email AS assignee_email, t.not_applicable, t.not_applicable_reason,
            t.not_applicable_marked_at, t.verified_scan_id, t.updated_at
       FROM soc2_remediation_tasks t
       LEFT JOIN users u ON u.id = t.assignee_user_id
      WHERE t.organization_id = $1
      ORDER BY
        CASE t.status
          WHEN 'todo' THEN 0
          WHEN 'in_progress' THEN 1
          WHEN 'verified' THEN 2
          ELSE 3
        END,
        t.priority ASC,
        t.updated_at DESC`,
    [organizationId],
  );
  return (rows as TaskRow[]).map(mapTask);
}

/** Org members who can be assigned a task. Best-effort (empty on error). */
export async function getAssignableMembers(organizationId: string): Promise<OrgMember[]> {
  try {
    const { rows } = await getScanPool().query(
      `SELECT m.user_id, u.email, m.role
         FROM org_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1
          AND u.status = 'active'
        ORDER BY u.email ASC`,
      [organizationId],
    );
    return (rows as Array<{ user_id: string; email: string; role: string }>).map((r) => ({
      userId: String(r.user_id),
      email: String(r.email),
      role: String(r.role),
    }));
  } catch {
    return [];
  }
}

/** Build the full kanban board for an org in a single pass. */
export async function getRemediationBoard(organizationId: string): Promise<RemediationBoard> {
  const [tasks, members] = await Promise.all([
    getRemediationTasks(organizationId),
    getAssignableMembers(organizationId),
  ]);

  const active = tasks.filter((t) => !t.notApplicable);
  return {
    todo: active.filter((t) => t.status === "todo"),
    inProgress: active.filter((t) => t.status === "in_progress"),
    verified: active.filter((t) => t.status === "verified"),
    notApplicable: tasks.filter((t) => t.notApplicable),
    members,
  };
}

/** Assign (or clear, when assigneeUserId is null) a task owner. */
export async function assignTask(
  organizationId: string,
  taskId: string,
  assigneeUserId: string | null,
): Promise<void> {
  await getScanPool().query(
    `UPDATE soc2_remediation_tasks
        SET assignee_user_id = $3, updated_at = now()
      WHERE organization_id = $1 AND id = $2`,
    [organizationId, taskId, assigneeUserId],
  );
}

/** Set (or clear, when dueAt is null) a task due date. */
export async function setTaskDueDate(
  organizationId: string,
  taskId: string,
  dueAt: string | null,
): Promise<void> {
  await getScanPool().query(
    `UPDATE soc2_remediation_tasks
        SET due_at = $3, updated_at = now()
      WHERE organization_id = $1 AND id = $2`,
    [organizationId, taskId, dueAt],
  );
}

/**
 * Move a task between the human-controllable columns only. 'verified' is NOT a
 * valid target — the guard rejects it so a human can never assert verification.
 * Verified/not-applicable tasks cannot be hand-moved either.
 */
export async function setTaskStatus(
  organizationId: string,
  taskId: string,
  nextStatus: "todo" | "in_progress",
): Promise<void> {
  if (nextStatus !== "todo" && nextStatus !== "in_progress") {
    throw new Error("invalid_status_transition");
  }
  await getScanPool().query(
    `UPDATE soc2_remediation_tasks
        SET status = $3, updated_at = now()
      WHERE organization_id = $1
        AND id = $2
        AND status IN ('todo', 'in_progress')
        AND not_applicable = false`,
    [organizationId, taskId, nextStatus],
  );
}

/**
 * Mark a finding "not applicable" with a justification preserved for the
 * auditor. Requires a non-empty reason. Records who marked it and when.
 */
export async function markTaskNotApplicable(
  organizationId: string,
  taskId: string,
  reason: string,
  markedByUserId: string,
): Promise<void> {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new Error("justification_required");
  }
  await getScanPool().query(
    `UPDATE soc2_remediation_tasks
        SET not_applicable = true,
            not_applicable_reason = $3,
            not_applicable_marked_by = $4,
            not_applicable_marked_at = now(),
            updated_at = now()
      WHERE organization_id = $1 AND id = $2`,
    [organizationId, taskId, trimmed, markedByUserId],
  );
}

/** Clear a not-applicable mark, returning the task to the active board. */
export async function clearTaskNotApplicable(
  organizationId: string,
  taskId: string,
): Promise<void> {
  await getScanPool().query(
    `UPDATE soc2_remediation_tasks
        SET not_applicable = false,
            not_applicable_reason = NULL,
            not_applicable_marked_by = NULL,
            not_applicable_marked_at = NULL,
            status = CASE WHEN status = 'verified' THEN 'todo' ELSE status END,
            updated_at = now()
      WHERE organization_id = $1 AND id = $2`,
    [organizationId, taskId],
  );
}
