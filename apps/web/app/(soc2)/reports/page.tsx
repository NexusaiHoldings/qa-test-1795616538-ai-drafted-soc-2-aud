import Link from "next/link";
import { sql } from "@vercel/postgres";

type ReportRow = {
  id: string;
  score: number;
  score_delta: number;
  newly_deficient_count: number;
  resolved_count: number;
  readiness_weeks: number;
  created_at: string;
};

export default async function ReportsPage(): Promise<JSX.Element> {
  const reports = await sql<ReportRow>`
    SELECT id, score, score_delta, newly_deficient_count, resolved_count, readiness_weeks, created_at
    FROM soc2_gap_reports
    ORDER BY created_at DESC
    LIMIT 20
  `;

  return (
    <main>
      <h1>Weekly SOC 2 reports</h1>
      <p>Track score trend and what changed each Monday scan.</p>
      {reports.rowCount === 0 ? (
        <div className="empty">Your first weekly report lands Monday.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Score</th>
              <th>Delta</th>
              <th>New deficient</th>
              <th>Resolved</th>
              <th>Readiness (weeks)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {reports.rows.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.created_at).toLocaleDateString()}</td>
                <td>{r.score}</td>
                <td>{r.score_delta >= 0 ? `+${r.score_delta}` : r.score_delta}</td>
                <td>{r.newly_deficient_count}</td>
                <td>{r.resolved_count}</td>
                <td>{r.readiness_weeks}</td>
                <td>
                  <Link href={`/reports/${r.id}`} className="btn secondary">
                    View
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
