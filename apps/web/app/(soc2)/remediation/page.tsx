import { listRemediationTasks } from "@/lib/soc2/reports/remediation";

export default async function RemediationPage(): Promise<JSX.Element> {
  const organizationId = process.env.DEFAULT_ORGANIZATION_ID ?? "";
  const tasks = organizationId ? await listRemediationTasks(organizationId) : [];
  const todo = tasks.filter((t) => t.status === "todo");
  const progress = tasks.filter((t) => t.status === "in_progress");
  const verified = tasks.filter((t) => t.status === "verified");

  return (
    <main>
      <h1>Remediation Tracker</h1>
      <p>Move work through To do and In progress; Verified only when scan passes.</p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
        {[["To do", todo], ["In progress", progress], ["Verified by scan", verified]].map(([label, items]) => (
          <section key={label} className="card">
            <h2>{label}</h2>
            {(items as typeof tasks).length === 0 ? (
              <p className="muted">No tasks</p>
            ) : (
              <ul>
                {(items as typeof tasks).map((task) => (
                  <li key={task.id}>
                    <strong>{task.title}</strong> — {task.severity} — priority {task.priority}
                    {task.notApplicable ? ` (N/A: ${task.notApplicableReason ?? "reason provided"})` : ""}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}
