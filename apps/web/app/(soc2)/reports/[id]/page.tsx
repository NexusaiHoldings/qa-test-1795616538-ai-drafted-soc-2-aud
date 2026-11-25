/**
 * /reports/[id] — a single weekly report's "what changed" timeline (F1-006).
 *
 * Shows the score delta hero + a chronological timeline of every control that
 * became newly deficient or was verified resolved since the prior scan. Server
 * component, org-scoped via resolveScanAccess (a report that isn't the viewer's
 * org 404s rather than leaking another tenant's gaps).
 */

import type { JSX } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveScanAccess, getScanPool } from "@/lib/soc2/scan/access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ReportRow {
  id: string;
  score: number;
  previous_score: number;
  score_delta: number;
  newly_deficient_count: number;
  resolved_count: number;
  readiness_weeks: number;
  created_at: string;
}

interface ChangeRow {
  id: string;
  change_type: string;
  previous_status: string | null;
  current_status: string | null;
  rule_id: string;
  finding_title: string | null;
  severity: string | null;
  created_at: string;
}

async function loadReport(organizationId: string, reportId: string): Promise<ReportRow | null> {
  const { rows } = await getScanPool().query(
    `SELECT id, score, previous_score, score_delta, newly_deficient_count,
            resolved_count, readiness_weeks, created_at
       FROM soc2_gap_reports
      WHERE id = $1 AND organization_id = $2
      LIMIT 1`,
    [reportId, organizationId],
  );
  const row = (rows as ReportRow[])[0];
  return row ?? null;
}

async function loadChanges(organizationId: string, reportId: string): Promise<ChangeRow[]> {
  const { rows } = await getScanPool().query(
    `SELECT c.id, c.change_type, c.previous_status, c.current_status, c.rule_id,
            f.title AS finding_title, f.severity, c.created_at
       FROM soc2_gap_report_changes c
       LEFT JOIN soc2_findings f ON f.id = c.finding_id
      WHERE c.report_id = $1 AND c.organization_id = $2
      ORDER BY
        CASE c.change_type WHEN 'newly_deficient' THEN 0 ELSE 1 END,
        c.created_at DESC`,
    [reportId, organizationId],
  );
  return rows as ChangeRow[];
}

function severityPill(severity: string | null): JSX.Element | null {
  if (!severity) return null;
  const label = severity.charAt(0).toUpperCase() + severity.slice(1);
  return (
    <span
      className="muted"
      style={{
        border: "1px solid currentColor",
        borderRadius: 999,
        padding: "0 8px",
        fontSize: "0.75rem",
        marginLeft: 8,
      }}
    >
      {label}
    </span>
  );
}

export default async function ReportDetailPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const access = await resolveScanAccess();
  if (!access) {
    return (
      <main>
        <h1>Report details</h1>
        <p>Your session or workspace role has expired. Re-verify to view this report.</p>
        <Link href="/connect" className="btn">
          Re-verify workspace
        </Link>
      </main>
    );
  }

  const report = await loadReport(access.organizationId, params.id);
  if (!report) notFound();

  const changes = await loadChanges(access.organizationId, params.id);
  const deltaLabel = report.score_delta > 0 ? `+${report.score_delta}` : String(report.score_delta);

  return (
    <main>
      <p>
        <Link href="/reports" className="muted">
          &larr; All reports
        </Link>
      </p>
      <h1>What changed this week</h1>
      <p>Report from {new Date(report.created_at).toLocaleDateString()}.</p>

      <section className="card" style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
          <div>
            <strong style={{ fontSize: "2rem", lineHeight: 1 }}>{report.score}</strong>
            <div className="muted">
              coverage score ({deltaLabel} from {report.previous_score})
            </div>
          </div>
          <div>
            <strong style={{ fontSize: "2rem", lineHeight: 1 }}>{report.newly_deficient_count}</strong>
            <div className="muted">newly deficient</div>
          </div>
          <div>
            <strong style={{ fontSize: "2rem", lineHeight: 1 }}>{report.resolved_count}</strong>
            <div className="muted">verified resolved</div>
          </div>
          <div>
            <strong style={{ fontSize: "2rem", lineHeight: 1 }}>~{report.readiness_weeks}</strong>
            <div className="muted">week(s) to audit-ready</div>
          </div>
        </div>
      </section>

      <h2>Timeline</h2>
      {changes.length === 0 ? (
        <div className="empty">
          No controls changed state since the prior scan — a clean, steady week.
        </div>
      ) : (
        <ul>
          {changes.map((c) => (
            <li key={c.id} style={{ marginBottom: 8 }}>
              <strong>
                {c.change_type === "newly_deficient" ? "⚠ Now deficient" : "✓ Verified resolved"}
              </strong>
              {": "}
              {c.finding_title ?? `Rule ${c.rule_id.slice(0, 8)}`}
              {severityPill(c.severity)}
              <div className="muted">
                {(c.previous_status ?? "unknown")} → {(c.current_status ?? "unknown")} ·{" "}
                {new Date(c.created_at).toLocaleString()}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
