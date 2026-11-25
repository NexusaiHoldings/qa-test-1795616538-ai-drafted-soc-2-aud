/**
 * /scan/[id] — SOC 2 coverage score + findings (F1-004).
 *
 * The single focal point is a large animated radial coverage score. Beneath it a
 * severity-sorted finding list with evidence chips and "why" expanders. Free-tier
 * CTOs see the score + the top three findings; the rest is a blurred locked
 * section with one transparent "Unlock the full scan — $2,000/mo flat" CTA. While
 * a scan is still running we show skeleton loaders; an expired role renders a
 * re-verify error state. A persistent "preparatory tool, not an audit opinion"
 * disclaimer strip is required by the liability assessor.
 *
 * Server component. The radial animates via SVG SMIL + scoped CSS keyframes — no
 * client JS needed.
 */

import type { JSX } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveScanAccess, getScanPool, trackPaywallViewed } from "@/lib/soc2/scan/access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DISCLAIMER = "Preparatory tool, not an audit opinion.";
const FREE_FINDING_LIMIT = 3;

interface ScanRow {
  id: string;
  status: string;
  score: number;
  compliant_count: number;
  deficient_count: number;
  not_assessed_count: number;
  findings_total: number;
}

interface FindingRow {
  id: string;
  status: string;
  severity: string;
  title: string;
  rationale: string;
  provider: string;
  resource_type: string;
  evidence_link: string | null;
}

async function loadScan(organizationId: string, scanId: string): Promise<ScanRow | null> {
  try {
    const { rows } = await getScanPool().query(
      `SELECT id, status, score, compliant_count, deficient_count,
              not_assessed_count, findings_total
         FROM soc2_gap_scans
        WHERE id = $1 AND organization_id = $2
        LIMIT 1`,
      [scanId, organizationId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      status: String(row.status),
      score: Number(row.score ?? 0),
      compliant_count: Number(row.compliant_count ?? 0),
      deficient_count: Number(row.deficient_count ?? 0),
      not_assessed_count: Number(row.not_assessed_count ?? 0),
      findings_total: Number(row.findings_total ?? 0),
    };
  } catch {
    return null;
  }
}

async function loadFindings(organizationId: string, scanId: string): Promise<FindingRow[]> {
  try {
    const { rows } = await getScanPool().query(
      `SELECT id, status, severity, title, rationale, provider, resource_type, evidence_link
         FROM soc2_findings
        WHERE scan_id = $1 AND organization_id = $2
        ORDER BY CASE severity
                   WHEN 'critical' THEN 1
                   WHEN 'high' THEN 2
                   WHEN 'medium' THEN 3
                   WHEN 'low' THEN 4
                   ELSE 5
                 END,
                 CASE status
                   WHEN 'deficient' THEN 1
                   WHEN 'not_assessed' THEN 2
                   ELSE 3
                 END,
                 created_at DESC`,
      [scanId, organizationId],
    );
    return (rows as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      status: String(row.status),
      severity: String(row.severity),
      title: String(row.title),
      rationale: String(row.rationale ?? ""),
      provider: String(row.provider ?? ""),
      resource_type: String(row.resource_type ?? ""),
      evidence_link: row.evidence_link ? String(row.evidence_link) : null,
    }));
  } catch {
    return [];
  }
}

function scoreColor(score: number): string {
  if (score >= 80) return "#1f9d55";
  if (score >= 50) return "#c9820b";
  return "#c0392b";
}

function statusLabel(status: string): string {
  if (status === "compliant") return "Compliant";
  if (status === "deficient") return "Deficient";
  return "Not assessed";
}

/** Large animated radial coverage score — the single focal point. */
function RadialScore({ score, status }: { score: number; status: string }): JSX.Element {
  const radius = 84;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, score));
  const offset = circumference * (1 - clamped / 100);
  const color = scoreColor(clamped);

  return (
    <div className="card" style={{ textAlign: "center" }}>
      <svg
        width="220"
        height="220"
        viewBox="0 0 220 220"
        role="img"
        aria-label={`Coverage score ${clamped} out of 100`}
        style={{ maxWidth: "100%" }}
      >
        <circle
          cx="110"
          cy="110"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.12"
          strokeWidth="16"
        />
        <circle
          cx="110"
          cy="110"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="16"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 110 110)"
        >
          <animate
            attributeName="stroke-dashoffset"
            from={circumference}
            to={offset}
            dur="1.1s"
            fill="freeze"
            calcMode="spline"
            keySplines="0.4 0 0.2 1"
            keyTimes="0;1"
          />
        </circle>
        <text
          x="110"
          y="104"
          textAnchor="middle"
          fontSize="48"
          fontWeight="700"
          fill="currentColor"
        >
          {clamped}
        </text>
        <text x="110" y="134" textAnchor="middle" fontSize="15" fill="currentColor" opacity="0.6">
          / 100
        </text>
      </svg>
      <p className="muted">Severity-weighted control coverage · {status}</p>
    </div>
  );
}

/** Skeleton shimmer shown while a scan is still running. */
function ScanSkeleton(): JSX.Element {
  return (
    <main>
      <style>{`
        @keyframes soc2-skeleton-pulse { 0% { opacity: 0.45; } 50% { opacity: 0.9; } 100% { opacity: 0.45; } }
        .soc2-skel { background: currentColor; opacity: 0.12; border-radius: 8px; animation: soc2-skeleton-pulse 1.3s ease-in-out infinite; }
      `}</style>
      <h1>SOC 2 Coverage Score</h1>
      <p>Evaluating your connected evidence against the Common Criteria check rules…</p>
      <div className="card" style={{ textAlign: "center" }}>
        <div className="soc2-skel" style={{ width: 200, height: 200, borderRadius: "50%", margin: "0 auto" }} />
      </div>
      <div className="soc2-skel" style={{ height: 72, marginTop: 16 }} />
      <div className="soc2-skel" style={{ height: 72, marginTop: 12 }} />
      <div className="soc2-skel" style={{ height: 72, marginTop: 12 }} />
      <p className="muted">{DISCLAIMER}</p>
    </main>
  );
}

function FindingCard({ finding }: { finding: FindingRow }): JSX.Element {
  return (
    <li className="card">
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <span className="btn secondary">{finding.severity}</span>
        <span className="muted">{statusLabel(finding.status)}</span>
      </div>
      <strong>{finding.title}</strong>
      <div className="toolbar" style={{ marginTop: 8 }}>
        <span className="muted">{finding.provider}</span>
        <span className="muted">{finding.resource_type}</span>
        {finding.evidence_link ? (
          <Link className="btn secondary" href={finding.evidence_link}>
            Evidence
          </Link>
        ) : (
          <span className="muted">No evidence collected</span>
        )}
      </div>
      <details style={{ marginTop: 8 }}>
        <summary>Why this fired</summary>
        <p>{finding.rationale || "This control rule has not yet been assessed against collected evidence."}</p>
      </details>
    </li>
  );
}

export default async function Soc2ScanDetailPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const access = await resolveScanAccess();
  if (!access) {
    return (
      <main>
        <h1>SOC 2 Coverage Score</h1>
        <p>Your session or workspace role has expired.</p>
        <div className="card">
          <h2>Re-verify to view this scan</h2>
          <p className="muted">Reconnect your identity to view your coverage score and findings.</p>
          <Link className="btn" href="/connect">
            Re-verify access
          </Link>
        </div>
        <p className="muted">{DISCLAIMER}</p>
      </main>
    );
  }

  const scan = await loadScan(access.organizationId, params.id);
  if (!scan) {
    notFound();
  }

  if (scan.status === "running") {
    return <ScanSkeleton />;
  }

  const allFindings = await loadFindings(access.organizationId, scan.id);
  const visibleFindings = access.canViewFullFindings
    ? allFindings
    : allFindings.slice(0, FREE_FINDING_LIMIT);
  const lockedCount = Math.max(0, allFindings.length - visibleFindings.length);

  if (!access.canViewFullFindings) {
    await trackPaywallViewed(access.organizationId, scan.id, access.userId);
  }

  return (
    <main>
      <h1>SOC 2 Coverage Score</h1>
      <p>A deterministic, evidence-backed view of your SOC 2 Common Criteria readiness.</p>

      <RadialScore score={scan.score} status={scan.status} />

      <div className="toolbar">
        <span className="card">Compliant: {scan.compliant_count}</span>
        <span className="card">Deficient: {scan.deficient_count}</span>
        <span className="card">Not assessed: {scan.not_assessed_count}</span>
      </div>

      <h2>Findings</h2>
      {visibleFindings.length === 0 ? (
        <div className="empty">
          <p>No findings for this scan. Connect AWS and GitHub, then re-run the scan.</p>
        </div>
      ) : (
        <ul>
          {visibleFindings.map((finding) => (
            <FindingCard key={finding.id} finding={finding} />
          ))}
        </ul>
      )}

      {!access.canViewFullFindings && lockedCount > 0 ? (
        <section style={{ position: "relative", marginTop: 16 }}>
          <div style={{ filter: "blur(6px)", pointerEvents: "none", userSelect: "none" }} aria-hidden="true">
            <ul>
              <li className="card">
                <strong>{lockedCount} more findings with full remediation detail</strong>
                <p className="muted">high · Deficient</p>
              </li>
              <li className="card">
                <strong>Generated SOC 2 policy suite + weekly automated runs</strong>
                <p className="muted">medium · Not assessed</p>
              </li>
            </ul>
          </div>
          <div
            className="card"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
            }}
          >
            <h3>Unlock the full scan — $2,000/mo flat</h3>
            <p className="muted">
              Full findings with remediation steps, a generated SOC 2 policy suite, and automatic
              weekly gap scans. One flat price, no per-seat surprises.
            </p>
            <Link className="btn" href="/billing">
              Unlock the full scan — $2,000/mo flat
            </Link>
          </div>
        </section>
      ) : null}

      <p className="muted" style={{ marginTop: 24 }}>
        {DISCLAIMER}
      </p>
    </main>
  );
}
