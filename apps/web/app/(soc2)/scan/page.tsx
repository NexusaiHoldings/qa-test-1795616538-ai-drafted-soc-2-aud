import Link from "next/link";
import { sql } from "@vercel/postgres";
import { requireSoc2ScanAccess, trackPaywallViewed } from "@/lib/soc2/scan/access";

type ScanRow = {
  id: string;
  status: string;
  score: number;
  findings_total: number;
  created_at: string;
};

export default async function Soc2ScanPage(): Promise<JSX.Element> {
  const access = await requireSoc2ScanAccess();

  const latest = await sql<ScanRow>`
    SELECT id, status, score, findings_total, created_at
    FROM soc2_gap_scans
    WHERE organization_id = ${access.organizationId}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const scan = latest.rows[0];

  if (scan && access.tier === "free") {
    await trackPaywallViewed(access.organizationId, scan.id);
  }

  return (
    <main>
      <h1>SOC 2 Free Gap Scan</h1>
      <p>Run a preparatory SOC 2 control coverage check and see immediate gaps.</p>

      {!scan ? (
        <div className="empty">
          <p>No scan yet. Connect data sources and run your first scan.</p>
        </div>
      ) : (
        <div className="card">
          <h2>Latest score: {scan.score}/100</h2>
          <p className="muted">Status: {scan.status}</p>
          <p className="muted">Findings: {scan.findings_total}</p>
          <Link className="btn" href={`/scan/${scan.id}`}>
            View scan details
          </Link>
        </div>
      )}

      <p className="muted">Preparatory tool, not an audit opinion.</p>
    </main>
  );
}
