import Link from "next/link";
import { getServerSession } from "@nexus/identity-and-access";
import { sql } from "@vercel/postgres";
import { runGapScan } from "@/lib/soc2/scan/run";

export default async function ScanPage(): Promise<JSX.Element> {
  const session = await getServerSession();
  const organizationId = String(session?.organizationId ?? "");
  const userId = String(session?.user?.id ?? "");

  async function startScanAction(): Promise<void> {
    "use server";
    if (!organizationId || !userId) return;
    await runGapScan(organizationId, userId);
  }

  const latest = organizationId
    ? await sql<{ id: string; score: number; status: string; created_at: string }>`
        SELECT id, score, status, created_at
        FROM soc2_gap_scans
        WHERE organization_id = ${organizationId}::uuid
        ORDER BY created_at DESC
        LIMIT 1
      `
    : { rows: [] as { id: string; score: number; status: string; created_at: string }[] };

  return (
    <main>
      <h1>SOC 2 Gap Scan</h1>
      <p className="muted">Run a free preparatory scan and get immediate coverage visibility.</p>

      <div className="card">
        <p><strong>Disclaimer:</strong> Preparatory tool, not an audit opinion.</p>
        <form action={startScanAction}>
          <button type="submit">Run free gap scan</button>
        </form>
      </div>

      {latest.rows.length > 0 ? (
        <div className="card">
          <h2>Latest scan</h2>
          <p>Status: {latest.rows[0].status}</p>
          <p>Score: {latest.rows[0].score}</p>
          <p>
            <Link className="btn" href={`/scan/${latest.rows[0].id}`}>
              View results
            </Link>
          </p>
        </div>
      ) : (
        <div className="empty">No scans yet. Run your first scan.</div>
      )}
    </main>
  );
}
