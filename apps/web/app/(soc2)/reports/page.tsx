/**
 * /reports — weekly SOC 2 gap reports (F1-006).
 *
 * Trend-first: a hero sparkline of the coverage-score trend is the focal point,
 * followed by a table of each Monday's report (score, delta, newly deficient,
 * resolved, estimated weeks-to-audit-ready). Server component, org-scoped via
 * resolveScanAccess. Empty state: "Your first weekly report lands Monday".
 */

import type { JSX } from "react";
import Link from "next/link";
import { resolveScanAccess, getScanPool } from "@/lib/soc2/scan/access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ReportRow {
  id: string;
  score: number;
  score_delta: number;
  newly_deficient_count: number;
  resolved_count: number;
  readiness_weeks: number;
  created_at: string;
}

async function loadReports(organizationId: string): Promise<ReportRow[]> {
  const { rows } = await getScanPool().query(
    `SELECT id, score, score_delta, newly_deficient_count, resolved_count,
            readiness_weeks, created_at
       FROM soc2_gap_reports
      WHERE organization_id = $1
      ORDER BY created_at DESC
      LIMIT 26`,
    [organizationId],
  );
  return rows as ReportRow[];
}

/**
 * Pure server-rendered sparkline — a <polyline> over the score history (oldest
 * → newest). No client island required; the chart is the page's focal hero.
 */
function Sparkline({ scores }: { scores: number[] }): JSX.Element {
  const width = 640;
  const height = 160;
  const pad = 12;
  const min = Math.min(...scores, 0);
  const max = Math.max(...scores, 100);
  const span = max - min || 1;
  const stepX = scores.length > 1 ? (width - pad * 2) / (scores.length - 1) : 0;

  const points = scores.map((s, i) => {
    const x = pad + i * stepX;
    const y = height - pad - ((s - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = points[points.length - 1]?.split(",") ?? ["0", "0"];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Coverage score trend"
      style={{ width: "100%", height: "auto", display: "block" }}
    >
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r={4} fill="currentColor" />
    </svg>
  );
}

function ExpiredState(): JSX.Element {
  return (
    <main>
      <h1>Weekly SOC 2 reports</h1>
      <p>Your session or workspace role has expired. Re-verify to view reports.</p>
      <Link href="/connect" className="btn">
        Re-verify workspace
      </Link>
    </main>
  );
}

export default async function ReportsPage(): Promise<JSX.Element> {
  const access = await resolveScanAccess();
  if (!access) return <ExpiredState />;

  const reports = await loadReports(access.organizationId);

  if (reports.length === 0) {
    return (
      <main>
        <h1>Weekly SOC 2 reports</h1>
        <p>Track your coverage-score trend and what changed in each Monday scan.</p>
        <div className="empty">
          <svg
            viewBox="0 0 120 80"
            role="img"
            aria-label="Calendar illustration"
            style={{ width: 120, height: 80, opacity: 0.5, marginBottom: 12 }}
          >
            <rect x="12" y="16" width="96" height="56" rx="6" fill="none" stroke="currentColor" strokeWidth="3" />
            <line x1="12" y1="32" x2="108" y2="32" stroke="currentColor" strokeWidth="3" />
            <line x1="34" y1="8" x2="34" y2="22" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            <line x1="86" y1="8" x2="86" y2="22" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            <circle cx="60" cy="52" r="7" fill="currentColor" />
          </svg>
          <p>Your first weekly report lands Monday.</p>
          <p className="muted">
            We re-run your scan automatically — this replaces manual gap tracking, it doesn&apos;t add to it.
          </p>
        </div>
      </main>
    );
  }

  const latest = reports[0];
  const chronological = [...reports].reverse();
  const scores = chronological.map((r) => r.score);
  const deltaLabel =
    latest.score_delta > 0
      ? `+${latest.score_delta}`
      : String(latest.score_delta);

  return (
    <main>
      <h1>Weekly SOC 2 reports</h1>
      <p>Your coverage-score trend and what changed in each Monday scan.</p>

      <section className="card" style={{ marginBottom: 24 }}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "baseline",
            gap: 16,
            marginBottom: 12,
          }}
        >
          <strong style={{ fontSize: "2.5rem", lineHeight: 1 }}>{latest.score}</strong>
          <span className="muted">coverage score</span>
          <span style={{ marginLeft: "auto" }}>
            {deltaLabel} this week · ~{latest.readiness_weeks} week(s) to audit-ready
          </span>
        </div>
        <Sparkline scores={scores} />
      </section>

      <table>
        <thead>
          <tr>
            <th>Report date</th>
            <th>Score</th>
            <th>Δ</th>
            <th>New gaps</th>
            <th>Resolved</th>
            <th>Weeks to ready</th>
            <th aria-label="actions" />
          </tr>
        </thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.created_at).toLocaleDateString()}</td>
              <td>{r.score}</td>
              <td>{r.score_delta > 0 ? `+${r.score_delta}` : r.score_delta}</td>
              <td>{r.newly_deficient_count}</td>
              <td>{r.resolved_count}</td>
              <td>{r.readiness_weeks}</td>
              <td>
                <Link href={`/reports/${r.id}`} className="btn secondary">
                  What changed
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
