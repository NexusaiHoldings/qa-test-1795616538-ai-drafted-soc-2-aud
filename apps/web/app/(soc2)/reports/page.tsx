import { listWeeklyReports } from "@/lib/soc2/reports/weekly";

export default async function ReportsPage(): Promise<JSX.Element> {
  const organizationId = process.env.DEFAULT_ORGANIZATION_ID ?? "";
  const reports = organizationId ? await listWeeklyReports(organizationId) : [];
  const trend = reports.slice(0, 12).reverse().map((r) => r.score);

  return (
    <main>
      <h1>Weekly SOC 2 Gap Reports</h1>
      <p>Trend-first view of your readiness score and what changed week over week.</p>

      {reports.length === 0 ? (
        <section className="empty">
          <p>Your first weekly report lands Monday.</p>
        </section>
      ) : (
        <>
          <section className="card">
            <h2>Score Trend</h2>
            <p className="muted">{trend.join(" · ")}</p>
          </section>

          <table>
            <thead>
              <tr>
                <th>Week</th>
                <th>Score</th>
                <th>Delta</th>
                <th>Newly deficient</th>
                <th>Resolved</th>
                <th>Readiness</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((report) => (
                <tr key={report.id}>
                  <td>
                    <a href={`/reports/${report.id}`}>{new Date(report.createdAt).toLocaleDateString()}</a>
                  </td>
                  <td>{report.score}</td>
                  <td>{report.scoreDelta}</td>
                  <td>{report.newlyDeficientCount}</td>
                  <td>{report.resolvedCount}</td>
                  <td>{report.readinessWeeks} weeks</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
