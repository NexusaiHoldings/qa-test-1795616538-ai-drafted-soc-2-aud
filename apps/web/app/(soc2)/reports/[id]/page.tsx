import { notFound } from "next/navigation";
import { sql } from "@vercel/postgres";

type Report = {
  id: string;
  score: number;
  score_delta: number;
  newly_deficient_count: number;
  resolved_count: number;
  readiness_weeks: number;
  created_at: string;
};

type Change = {
  id: string;
  change_type: string;
  previous_status: string | null;
  current_status: string | null;
  created_at: string;
};

export default async function ReportDetailPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const report = await sql<Report>`
    SELECT id, score, score_delta, newly_deficient_count, resolved_count, readiness_weeks, created_at
    FROM soc2_gap_reports
    WHERE id = ${params.id}
    LIMIT 1
  `;

  if (report.rowCount === 0) notFound();

  const changes = await sql<Change>`
    SELECT id, change_type, previous_status, current_status, created_at
    FROM soc2_gap_report_changes
    WHERE report_id = ${params.id}
    ORDER BY created_at DESC
  `;

  const r = report.rows[0];
  return (
    <main>
      <h1>Report details</h1>
      <p>What changed since the prior scan.</p>
      <div className="card">
        <p>Score: {r.score}</p>
        <p>Delta: {r.score_delta >= 0 ? `+${r.score_delta}` : r.score_delta}</p>
        <p>Newly deficient: {r.newly_deficient_count}</p>
        <p>Resolved: {r.resolved_count}</p>
        <p>Estimated weeks to ready: {r.readiness_weeks}</p>
      </div>
      <h2>Timeline</h2>
      {changes.rowCount === 0 ? (
        <div className="empty">No changes were recorded for this report.</div>
      ) : (
        <ul>
          {changes.rows.map((c) => (
            <li key={c.id}>
              <strong>{c.change_type}</strong> ({c.previous_status ?? "unknown"} →{" "}
              {c.current_status ?? "unknown"}) on{" "}
              {new Date(c.created_at).toLocaleString()}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
