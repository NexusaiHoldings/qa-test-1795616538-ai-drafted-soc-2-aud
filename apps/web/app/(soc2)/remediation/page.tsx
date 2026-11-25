/**
 * /remediation — the remediation kanban (F1-006).
 *
 * Three columns — To do / In progress / Verified by scan — where tasks reach
 * "Verified" ONLY when the next weekly scan passes the rule (see weekly.ts);
 * the UI never offers a human "mark verified" control. A finding can be marked
 * "not applicable" with a justification preserved for the auditor.
 *
 * Server component with inline Server Actions (owner assignment, due dates,
 * start/reopen, not-applicable). CSS-only tabs collapse the board on mobile;
 * tasteful card motion is handled by a scoped <style> block. Org-scoped via
 * resolveScanAccess.
 */

import type { JSX } from "react";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { resolveScanAccess } from "@/lib/soc2/scan/access";
import {
  getRemediationBoard,
  assignTask,
  setTaskDueDate,
  setTaskStatus,
  markTaskNotApplicable,
  clearTaskNotApplicable,
  type RemediationTask,
  type OrgMember,
} from "@/lib/soc2/reports/remediation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ── Server Actions ──────────────────────────────────────────────────────────

async function assignTaskAction(formData: FormData): Promise<void> {
  "use server";
  const access = await resolveScanAccess();
  if (!access) return;
  const taskId = String(formData.get("task_id") ?? "");
  const assignee = String(formData.get("assignee_user_id") ?? "");
  if (!taskId) return;
  await assignTask(access.organizationId, taskId, assignee.length > 0 ? assignee : null);
  revalidatePath("/remediation");
}

async function setDueDateAction(formData: FormData): Promise<void> {
  "use server";
  const access = await resolveScanAccess();
  if (!access) return;
  const taskId = String(formData.get("task_id") ?? "");
  const raw = String(formData.get("due_at") ?? "").trim();
  if (!taskId) return;
  const dueAt = raw.length > 0 ? new Date(`${raw}T00:00:00Z`).toISOString() : null;
  await setTaskDueDate(access.organizationId, taskId, dueAt);
  revalidatePath("/remediation");
}

async function startTaskAction(formData: FormData): Promise<void> {
  "use server";
  const access = await resolveScanAccess();
  if (!access) return;
  const taskId = String(formData.get("task_id") ?? "");
  if (!taskId) return;
  await setTaskStatus(access.organizationId, taskId, "in_progress");
  revalidatePath("/remediation");
}

async function reopenTaskAction(formData: FormData): Promise<void> {
  "use server";
  const access = await resolveScanAccess();
  if (!access) return;
  const taskId = String(formData.get("task_id") ?? "");
  if (!taskId) return;
  await setTaskStatus(access.organizationId, taskId, "todo");
  revalidatePath("/remediation");
}

async function markNotApplicableAction(formData: FormData): Promise<void> {
  "use server";
  const access = await resolveScanAccess();
  if (!access) return;
  const taskId = String(formData.get("task_id") ?? "");
  const reason = String(formData.get("reason") ?? "");
  if (!taskId || reason.trim().length === 0) return;
  await markTaskNotApplicable(access.organizationId, taskId, reason, access.userId);
  revalidatePath("/remediation");
}

async function clearNotApplicableAction(formData: FormData): Promise<void> {
  "use server";
  const access = await resolveScanAccess();
  if (!access) return;
  const taskId = String(formData.get("task_id") ?? "");
  if (!taskId) return;
  await clearTaskNotApplicable(access.organizationId, taskId);
  revalidatePath("/remediation");
}

// ── View helpers ────────────────────────────────────────────────────────────

const BOARD_STYLES = `
.kb-radio { position: absolute; opacity: 0; pointer-events: none; }
.kb-tabs { display: none; }
.kb-cols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.kb-col { min-width: 0; }
.kb-count { font-size: 0.8rem; opacity: 0.7; margin-left: 6px; }
.kb-card { animation: kb-rise 0.18s ease both; }
.kb-card.card { transition: transform 0.15s ease, box-shadow 0.15s ease; }
.kb-card.card:hover { transform: translateY(-2px); box-shadow: 0 4px 14px rgba(0,0,0,0.12); }
.kb-pill { border: 1px solid currentColor; border-radius: 999px; padding: 0 8px; font-size: 0.72rem; }
.kb-pill.high { color: #b4232a; }
.kb-pill.medium { color: #b5731a; }
.kb-pill.low { color: #4a4a4a; }
.kb-avatar { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 999px; border: 1px solid currentColor; font-size: 0.7rem; }
.kb-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
@keyframes kb-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@media (max-width: 720px) {
  .kb-tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
  .kb-tabs label { cursor: pointer; border: 1px solid currentColor; border-radius: 6px; padding: 4px 10px; opacity: 0.6; }
  .kb-cols { grid-template-columns: 1fr; }
  .kb-col { display: none; }
  #kb-todo:checked ~ .kb-tabs label[for="kb-todo"],
  #kb-prog:checked ~ .kb-tabs label[for="kb-prog"],
  #kb-ver:checked ~ .kb-tabs label[for="kb-ver"] { opacity: 1; font-weight: 600; }
  #kb-todo:checked ~ .kb-cols .kb-col[data-col="todo"],
  #kb-prog:checked ~ .kb-cols .kb-col[data-col="in_progress"],
  #kb-ver:checked ~ .kb-cols .kb-col[data-col="verified"] { display: block; }
}
`;

function initials(email: string | null): string {
  if (!email) return "?";
  const name = email.split("@")[0] ?? email;
  const parts = name.split(/[.\-_]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function SeverityPill({ severity }: { severity: string }): JSX.Element {
  const level = severity === "high" || severity === "medium" ? severity : "low";
  const label = level.charAt(0).toUpperCase() + level.slice(1);
  return <span className={`kb-pill ${level}`}>{label}</span>;
}

function formatDue(dueAt: string | null): JSX.Element {
  if (!dueAt) return <span className="muted">No due date</span>;
  const date = new Date(dueAt);
  const overdue = date.getTime() < Date.now();
  return (
    <span style={{ color: overdue ? "#b4232a" : undefined }}>
      {overdue ? "Overdue " : "Due "}
      {date.toLocaleDateString()}
    </span>
  );
}

function TaskCard({ task, members }: { task: RemediationTask; members: OrgMember[] }): JSX.Element {
  const dueValue = task.dueAt ? task.dueAt.slice(0, 10) : "";
  return (
    <article className="card kb-card">
      <div className="kb-meta">
        <SeverityPill severity={task.severity} />
        <span
          className="kb-avatar"
          title={task.assigneeEmail ?? "Unassigned"}
          aria-label={task.assigneeEmail ?? "Unassigned"}
        >
          {initials(task.assigneeEmail)}
        </span>
        <span>{formatDue(task.dueAt)}</span>
      </div>
      <h3 style={{ margin: "4px 0" }}>{task.title}</h3>
      {task.description ? <p className="muted">{task.description}</p> : null}

      {task.status === "verified" ? (
        <p className="muted">✓ Verified by the latest scan — no action needed.</p>
      ) : (
        <details>
          <summary>Manage</summary>
          <div style={{ marginTop: 10, display: "grid", gap: 12 }}>
            <form action={assignTaskAction}>
              <input type="hidden" name="task_id" value={task.id} />
              <label>
                Owner{" "}
                <select name="assignee_user_id" defaultValue={task.assigneeUserId ?? ""}>
                  <option value="">Unassigned</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.email}
                    </option>
                  ))}
                </select>
              </label>{" "}
              <button type="submit">Save owner</button>
            </form>

            <form action={setDueDateAction}>
              <input type="hidden" name="task_id" value={task.id} />
              <label>
                Due date <input type="date" name="due_at" defaultValue={dueValue} />
              </label>{" "}
              <button type="submit">Save due date</button>
            </form>

            <div className="kb-meta">
              {task.status === "todo" ? (
                <form action={startTaskAction}>
                  <input type="hidden" name="task_id" value={task.id} />
                  <button type="submit">Start work</button>
                </form>
              ) : (
                <form action={reopenTaskAction}>
                  <input type="hidden" name="task_id" value={task.id} />
                  <button type="submit" className="secondary">
                    Move back to To do
                  </button>
                </form>
              )}
            </div>

            <form action={markNotApplicableAction}>
              <input type="hidden" name="task_id" value={task.id} />
              <label>
                Mark not applicable (justification kept for the auditor)
                <textarea
                  name="reason"
                  required
                  rows={2}
                  placeholder="Why this control does not apply to our environment…"
                />
              </label>
              <button type="submit" className="secondary">
                Mark not applicable
              </button>
            </form>
          </div>
        </details>
      )}
    </article>
  );
}

function Column({
  title,
  col,
  tasks,
  members,
  emptyLabel,
}: {
  title: string;
  col: string;
  tasks: RemediationTask[];
  members: OrgMember[];
  emptyLabel: string;
}): JSX.Element {
  return (
    <section className="kb-col" data-col={col}>
      <h2>
        {title}
        <span className="kb-count">{tasks.length}</span>
      </h2>
      {tasks.length === 0 ? (
        <div className="empty">{emptyLabel}</div>
      ) : (
        tasks.map((t) => <TaskCard key={t.id} task={t} members={members} />)
      )}
    </section>
  );
}

export default async function RemediationPage(): Promise<JSX.Element> {
  const access = await resolveScanAccess();
  if (!access) {
    return (
      <main>
        <h1>Remediation tracker</h1>
        <p>Your session or workspace role has expired. Re-verify to view remediation.</p>
        <Link href="/connect" className="btn">
          Re-verify workspace
        </Link>
      </main>
    );
  }

  const board = await getRemediationBoard(access.organizationId);
  const total =
    board.todo.length + board.inProgress.length + board.verified.length + board.notApplicable.length;

  return (
    <main>
      <style dangerouslySetInnerHTML={{ __html: BOARD_STYLES }} />
      <h1>Remediation tracker</h1>
      <p>
        Tasks move to <strong>Verified by scan</strong> only when the next weekly scan passes the
        rule — never by hand. <Link href="/reports">See weekly reports</Link>.
      </p>

      {total === 0 ? (
        <div className="empty">
          <p>No open remediation tasks.</p>
          <p className="muted">
            Your first weekly report lands Monday — any new gaps show up here as assignable tasks.
          </p>
        </div>
      ) : (
        <div className="kanban">
          <input type="radio" name="kb" id="kb-todo" className="kb-radio" defaultChecked />
          <input type="radio" name="kb" id="kb-prog" className="kb-radio" />
          <input type="radio" name="kb" id="kb-ver" className="kb-radio" />
          <nav className="kb-tabs" aria-label="Kanban columns">
            <label htmlFor="kb-todo">To do ({board.todo.length})</label>
            <label htmlFor="kb-prog">In progress ({board.inProgress.length})</label>
            <label htmlFor="kb-ver">Verified ({board.verified.length})</label>
          </nav>
          <div className="kb-cols">
            <Column
              title="To do"
              col="todo"
              tasks={board.todo}
              members={board.members}
              emptyLabel="Nothing to start."
            />
            <Column
              title="In progress"
              col="in_progress"
              tasks={board.inProgress}
              members={board.members}
              emptyLabel="No tasks in progress."
            />
            <Column
              title="Verified by scan"
              col="verified"
              tasks={board.verified}
              members={board.members}
              emptyLabel="Nothing verified yet — the next scan confirms fixes."
            />
          </div>
        </div>
      )}

      {board.notApplicable.length > 0 ? (
        <section style={{ marginTop: 24 }}>
          <h2>Not applicable</h2>
          <p className="muted">
            These findings were scoped out with a justification preserved for the auditor.
          </p>
          {board.notApplicable.map((t) => (
            <article key={t.id} className="card">
              <div className="kb-meta">
                <SeverityPill severity={t.severity} />
                <strong>{t.title}</strong>
              </div>
              <p className="muted">
                Justification: {t.notApplicableReason ?? "—"}
                {t.notApplicableMarkedAt
                  ? ` (marked ${new Date(t.notApplicableMarkedAt).toLocaleDateString()})`
                  : ""}
              </p>
              <form action={clearNotApplicableAction}>
                <input type="hidden" name="task_id" value={t.id} />
                <button type="submit" className="secondary">
                  Restore to board
                </button>
              </form>
            </article>
          ))}
        </section>
      ) : null}
    </main>
  );
}
