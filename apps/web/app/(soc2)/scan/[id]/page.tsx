import Link from "next/link";
import { sql } from "@vercel/postgres";
import { notFound } from "next/navigation";
import { requireSoc2ScanAccess } from "@/lib/soc2/scan/access";

type ScanDetailsRow = {
  id: string;
  score: number;
  status: string;
  compliant_count: number;
  deficient_count: number;
  not_assessed_count: number;
};

type FindingRow = {
  id: string;
  status: string;
  severity: string;
  title: string;
  rationale: string;
  evidence_link: string | null;
};

export default async function Soc2ScanDetailsPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const access = await requireSoc2ScanAccess();

  const scanResult = await sql<ScanDetailsRow>`
    SELECT id, score, status, compliant_count, deficient_count, not_assessed_count
    FROM soc2_gap_scans
    WHERE id = ${params.id}
      AND organization_id = ${access.organizationId}
    LIMIT 1
  `;

  const scan = scanResult.rows[0];
  if (!scan) notFound();

  const findingsResult = await sql<FindingRow>`
    SELECT id, status, severity, title, rationale, evidence_link
    FROM soc2_findings
    WHERE scan_id = ${scan.id}
      AND organization_id = ${access.organizationId}
    ORDER BY
      CASE severity
        WHEN 'critical' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        ELSE 4
      END,
      created_at DESC
  `;

  const findings = access.canViewFullFindings ? findingsResult.rows : findingsResult.rows.slice(0, 3);

  return (
    <main>
      <h1>SOC 2 Scan Results</h1>
      <p>Severity-weighted coverage score with deterministic evidence mapping.</p>

      <div className="card">
        <h2>{scan.score}/100</h2>
        <p className="muted">Compliant: {scan.compliant_count}</p>
        <p className="muted">Deficient: {scan.deficient_count}</p>
        <p className="muted">Not assessed: {scan.not_assessed_count}</p>
      </div>

      <h2>Findings</h2>
      {findings.length === 0 ? (
        <div className="empty">
          <p>No findings for this scan.</p>
        </div>
      ) : (
        <ul>
          {findings.map((finding) => (
            <li key={finding.id} className="card">
              <strong>{finding.title}</strong>
              <p className="muted">
                {finding.severity} · {finding.status}
              </p>
              <details>
                <summary>Why</summary>
                <p>{finding.rationale}</p>
              </details>
              {finding.evidence_link ? (
                <p>
                  <Link href={finding.evidence_link}>Evidence</Link>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {!access.canViewFullFindings ? (
        <div className="card">
          <h3>Unlock the full scan — $2,000/mo flat</h3>
          <p className="muted">Get full findings, policy generation, and weekly runs.</p>
        </div>
      ) : null}

      <p className="muted">Preparatory tool, not an audit opinion.</p>
    </main>
  );
}
