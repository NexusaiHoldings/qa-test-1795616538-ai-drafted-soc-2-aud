import { getServerSession } from "@nexus/identity-and-access";
import { sql } from "@vercel/postgres";
import { getSoc2Access, emitPaywallViewed } from "@/lib/soc2/scan/access";

interface PageProps {
  params: { id: string };
}

export default async function ScanDetailPage({ params }: PageProps): Promise<JSX.Element> {
  const session = await getServerSession();
  const organizationId = String(session?.organizationId ?? "");
  const userId = String(session?.user?.id ?? "");
  const scanId = params.id;

  const [scanRes, findingsRes] = await Promise.all([
    sql<{
      id: string;
      status: string;
      score: number;
      compliant_count: number;
      deficient_count: number;
      not_assessed_count: number;
    }>`
      SELECT id, status, score, compliant_count, deficient_count, not_assessed_count
      FROM soc2_gap_scans
      WHERE id = ${scanId}::uuid AND organization_id = ${organizationId}::uuid
      LIMIT 1
    `,
    sql<{
      id: string;
      status: string;
      severity: string;
      title: string;
      rationale: string;
      evidence_link: string | null;
    }>`
      SELECT id, status, severity, title, rationale, evidence_link
      FROM soc2_findings
      WHERE scan_id = ${scanId}::uuid AND organization_id = ${organizationId}::uuid
      ORDER BY
        CASE severity
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          ELSE 4
        END ASC
    `,
  ]);

  if (scanRes.rows.length === 0) {
    return (
      <main>
        <h1>Scan not found</h1>
        <p className="muted">This scan does not exist for your organization.</p>
      </main>
    );
  }

  const access = await getSoc2Access(organizationId, userId);
  const findings = findingsRes.rows;
  const visibleFindings = access.canSeeFullFindings ? findings : findings.slice(0, access.findingsLimit);

  if (!access.canSeeFullFindings) {
    await emitPaywallViewed(organizationId, userId, scanId);
  }

  const scan = scanRes.rows[0];

  return (
    <main>
      <h1>Gap scan results</h1>
      <p className="muted">Preparatory tool, not an audit opinion.</p>

      <div className="card">
        <h2 style={{ fontSize: "3rem", lineHeight: 1, margin: 0 }}>{scan.score}</h2>
        <p>Coverage score (0-100)</p>
        <p className="muted">
          Compliant: {scan.compliant_count} · Deficient: {scan.deficient_count} · Not assessed: {scan.not_assessed_count}
        </p>
      </div>

      <h2>Findings</h2>
      {visibleFindings.length === 0 ? (
        <div className="empty">No findings available.</div>
      ) : (
        <ul>
          {visibleFindings.map((finding) => (
            <li key={finding.id} className="card">
              <p>
                <strong>{finding.title}</strong> — {finding.severity} · {finding.status}
              </p>
              <details>
                <summary>Why</summary>
                <p>{finding.rationale || "No additional rationale provided."}</p>
              </details>
              {finding.evidence_link ? <p><a href={finding.evidence_link}>Evidence</a></p> : null}
            </li>
          ))}
        </ul>
      )}

      {!access.canSeeFullFindings ? (
        <div className="card" aria-label="locked-section">
          <p><strong>Locked:</strong> Full findings, policies, and weekly runs.</p>
          <a className="btn" href="/billing">Unlock the full scan — $2,000/mo flat</a>
        </div>
      ) : null}
    </main>
  );
}
