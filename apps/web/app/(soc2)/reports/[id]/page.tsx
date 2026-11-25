import { Pool } from "pg";

async function getReport(reportId: string): Promise<any> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const pool = new Pool({ connectionString: databaseUrl });
  const report = await pool.query(`SELECT * FROM soc2_gap_reports WHERE id = $1`, [reportId]);
  const scanId = report.rows[0]?.scan_id;
  const findings = scanId
    ? await pool.query(
        `SELECT title, status, severity, updated_at FROM soc2_findings WHERE scan_id = $1 ORDER BY updated_at DESC`,
        [scanId],
      )
    : { rows: [] };
  await pool.end();
  return { report: report.rows[0] ?? null, findings: findings.rows };
}

export default async function ReportDetailPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const data = await getReport(params.id);

  if (!data?.report) {
    return (
      <main>
        <h1>Report not found</h1>
      </main>
    );
  }

  return (
    <main>
      <h1>Weekly Report Details</h1>
      <p>What changed since the prior scan.</p>
      <section className="card">
        <p>Score: {data.report.score}</p>
        <p>Delta: {data.report.score_delta}</p>
        <p>Newly deficient: {data.report.newly_deficient_count}</p>
        <p>Resolved: {data.report.resolved_count}</p>
        <p>Estimated readiness: {data.report.readiness_weeks} weeks</p>
      </section>
      <h2>Timeline</h2>
      <ul>
        {data.findings.map((f: any, idx: number) => (
          <li key={`${f.title}-${idx}`}>
            {new Date(f.updated_at).toLocaleString()} — {f.title} ({f.status}, {f.severity})
          </li>
        ))}
      </ul>
    </main>
  );
}
