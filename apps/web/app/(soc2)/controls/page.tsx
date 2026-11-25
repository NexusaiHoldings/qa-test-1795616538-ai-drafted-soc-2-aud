/**
 * /controls — the SOC 2 TSC control catalog (F1-003).
 *
 * Renders the five core Common Criteria families as grouped cards, each control
 * showing a Compliant / In-Progress / Deficient pill and each family a progress
 * ring. On load it idempotently seeds the catalog for the signed-in user's org,
 * runs the DETERMINISTIC evidence mapper (pure TypeScript over snapshot JSON —
 * no model), then reads the computed verdicts back. The empty state illustrates
 * an unconnected account with a single primary "Connect AWS" action.
 *
 * Server component — all evaluation happens server-side; there is no client JS.
 */

import type { JSX } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";
import { resolveOrgId, listConnectors, type Connector } from "@/lib/soc2/connectors/snapshot";
import {
  seedCatalog,
  listControls,
  groupByFamily,
  familyProgress,
  type ControlRow,
  type ControlStatus,
} from "@/lib/soc2/controls/catalog";
import { runMapping } from "@/lib/soc2/controls/mapper";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUS_META: Record<ControlStatus, { label: string; color: string }> = {
  compliant: { label: "Compliant", color: "#0a7d33" },
  in_progress: { label: "In Progress", color: "#9a6a00" },
  deficient: { label: "Deficient", color: "#8a1c1c" },
  not_started: { label: "Not Started", color: "#555" },
};

function StatusPill({ status }: { status: ControlStatus }): JSX.Element {
  const meta = STATUS_META[status];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: "#fff",
        background: meta.color,
        whiteSpace: "nowrap",
      }}
    >
      {meta.label}
    </span>
  );
}

/** A monochrome SVG progress ring showing the compliant fraction of a family. */
function ProgressRing({ value, label }: { value: number; label: string }): JSX.Element {
  const size = 56;
  const stroke = 6;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, value));
  const dash = circumference * clamped;
  const pct = Math.round(clamped * 100);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.15}
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference - dash}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          fontSize="14"
          fontWeight="700"
          fill="currentColor"
        >
          {pct}%
        </text>
      </svg>
    </div>
  );
}

function ControlCard({ control }: { control: ControlRow }): JSX.Element {
  const passed = control.rules.filter((r) => r.status === "pass").length;
  const failed = control.rules.filter((r) => r.status === "fail").length;
  return (
    <Link
      href={`/controls/${control.id}`}
      className="card"
      style={{
        display: "block",
        textDecoration: "none",
        color: "inherit",
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <strong>{control.controlKey}</strong>
          <span className="muted"> · {control.title}</span>
        </div>
        <StatusPill status={control.status} />
      </div>
      <p className="muted" style={{ marginBottom: 8 }}>
        {control.description}
      </p>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {control.rules.length} check{control.rules.length === 1 ? "" : "s"} · {passed} passing
        {failed > 0 ? ` · ${failed} failing` : ""}
      </p>
    </Link>
  );
}

export default async function ControlsPage(): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const orgId = await resolveOrgId(user.id);

  let controls: ControlRow[] = [];
  let connectors: Connector[] = [];
  if (orgId) {
    // Idempotent: ensure the catalog exists, then run the deterministic mapper
    // so the verdicts reflect the latest collected snapshots before rendering.
    await seedCatalog(orgId);
    await runMapping(orgId);
    controls = await listControls(orgId);
    connectors = await listConnectors(orgId);
  }

  const groups = groupByFamily(controls);
  const anyConnected = connectors.some((c) => c.status === "connected");
  const totalControls = controls.length;
  const compliant = controls.filter((c) => c.status === "compliant").length;

  return (
    <main>
      <h1>Control catalog</h1>
      <p>
        The five core SOC 2 Common Criteria families, evaluated deterministically
        against your connected evidence. Every verdict here is computed in pure
        code from a hashed snapshot — never by a model — so each finding traces
        back to the exact evidence that fired.
      </p>

      {!orgId && (
        <div className="card">
          <p>
            You need an organization before a control catalog can be scoped to
            you. <Link href="/org">Create or join an organization</Link> first.
          </p>
        </div>
      )}

      {orgId && !anyConnected && (
        <div className="empty">
          <h2>Connect an account to start evidencing controls</h2>
          <p className="muted">
            No AWS or GitHub account is connected yet, so there is no evidence to
            evaluate. Connect a read-only AWS role and we&apos;ll begin mapping
            evidence to the {totalControls || "ten"} controls automatically.
          </p>
          <p>
            <Link className="btn" href="/connect/aws">
              Connect AWS
            </Link>
          </p>
        </div>
      )}

      {orgId && anyConnected && (
        <p className="muted">
          {compliant} of {totalControls} controls compliant across{" "}
          {groups.length} families.
        </p>
      )}

      {groups.map(({ family, controls: familyControls }) => (
        <section key={family.key} style={{ marginTop: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <ProgressRing
              value={familyProgress(familyControls)}
              label={`${family.title} compliance`}
            />
            <div>
              <h2 style={{ margin: 0 }}>{family.title}</h2>
              <p className="muted" style={{ margin: 0 }}>
                {family.blurb}
              </p>
            </div>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
              gap: 16,
              marginTop: 14,
            }}
          >
            {familyControls.map((control) => (
              <ControlCard key={control.id} control={control} />
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
