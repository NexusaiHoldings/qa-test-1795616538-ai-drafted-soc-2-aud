import { getRemediationTasks } from "@/lib/soc2/reports/remediation";

export default async function RemediationPage(): Promise<JSX.Element> {
  const tasks = await getRemediationTasks("00000000-0000-0000-0000-000000000000");

  const todo = tasks.filter((t) => t.status === "todo");
  const inProgress = tasks.filter((t) => t.status === "in_progress");
  const verified = tasks.filter((t) => t.status === "verified");

  return (
    <main>
      <h1>Remediation tracker</h1>
      <p>Tasks move to verified only when the next scan passes.</p>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <section>
          <h2>To do</h2>
          {todo.length === 0 ? <div className="empty">No tasks.</div> : todo.map((t) => <article key={t.id} className="card"><h3>{t.title}</h3><p>{t.description}</p></article>)}
        </section>
        <section>
          <h2>In progress</h2>
          {inProgress.length === 0 ? <div className="empty">No tasks.</div> : inProgress.map((t) => <article key={t.id} className="card"><h3>{t.title}</h3><p>{t.description}</p></article>)}
        </section>
        <section>
          <h2>Verified by scan</h2>
          {verified.length === 0 ? <div className="empty">No tasks.</div> : verified.map((t) => <article key={t.id} className="card"><h3>{t.title}</h3><p>{t.description}</p></article>)}
        </section>
      </div>
    </main>
  );
}
