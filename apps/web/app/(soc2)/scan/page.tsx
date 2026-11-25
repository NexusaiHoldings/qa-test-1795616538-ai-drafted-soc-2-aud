/**
 * /scan — SOC 2 free gap scan front door (F1-004).
 *
 * The PLG entry point: a CTO who has connected AWS + GitHub runs a free gap scan
 * and is taken straight to the animated coverage score. Server component; the
 * only interactivity is the "Run gap scan" Server Action. When the session/org
 * has expired we render the re-verify error state instead of throwing.
 */

import type { JSX } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { resolveScanAccess, getScanPool } from "@/lib/soc2/scan/access";
import { runSoc2GapScan } from "@/lib/soc2/scan/run";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ScanRow {
  id: string;
  status: string;
  score: number;
  findings_total: number;
  created_at: string;
}

const DISCLAIMER = "Preparatory tool, not an audit opinion.";

async function loadLatestScan(organizationId: string): Promise<ScanRow | null> {
  try {
    const { rows } = await getScanPool().query(
      `SELECT id, status, score, findings_total, created_at
         FROM soc2_gap_scans
        WHERE organization_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [organizationId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      status: String(row.status),
      score: Number(row.score ?? 0),
      findings_total: Number(row.findings_total ?? 0),
      created_at: String(row.created_at ?? ""),
    };
  } catch {
    return null;
  }
}

/** Server Action: run a fresh gap scan, then jump to its score page. */
async function runScanAction(): Promise<void> {
  "use server";
  const access = await resolveScanAccess();
  if (!access) {
    redirect("/connect");
  }
  const scanId = await runSoc2GapScan(access.organizationId, access.userId);
  redirect(`/scan/${scanId}`);
}

function ExpiredState(): JSX.Element {
  return (
    <main>
      <h1>SOC 2 Free Gap Scan</h1>
      <p>Your session or workspace role has expired.</p>
      <div className="card">
        <h2>Re-verify to continue</h2>
        <p className="muted">
          We could not confirm an active workspace for your account. Reconnect your identity to run a
          gap scan.
        </p>
        <Link className="btn" href="/connect">
          Re-verify access
        </Link>
      </div>
      <p className="muted">{DISCLAIMER}</p>
    </main>
  );
}

export default async function Soc2ScanPage(): Promise<JSX.Element> {
  const access = await resolveScanAccess();
  if (!access) {
    return <ExpiredState />;
  }

  const latest = await loadLatestScan(access.organizationId);

  return (
    <main>
      <h1>SOC 2 Free Gap Scan</h1>
      <p>
        Run a preparatory SOC 2 Common Criteria coverage check over your connected AWS and GitHub
        evidence and see an immediate control coverage score — free.
      </p>

      <div className="card">
        <h2>Run your gap scan</h2>
        <p className="muted">
          Every check rule is evaluated deterministically against your latest snapshots. No model
          decides whether a control is met.
        </p>
        <form action={runScanAction}>
          <button type="submit">Run gap scan</button>
        </form>
      </div>

      {latest ? (
        <div className="card">
          <h2>Latest scan: {latest.score}/100</h2>
          <p className="muted">Status: {latest.status}</p>
          <p className="muted">Findings: {latest.findings_total}</p>
          <Link className="btn secondary" href={`/scan/${latest.id}`}>
            View coverage score
          </Link>
        </div>
      ) : (
        <div className="empty">
          <p>No scan yet. Run your first gap scan to see your coverage score.</p>
        </div>
      )}

      <p className="muted">{DISCLAIMER}</p>
    </main>
  );
}
