/**
 * /controls/[id] — a single SOC 2 control's evidence detail (F1-003).
 *
 * Shows the control text, each deterministic check rule, the evidence artifact
 * the mapper matched (snapshot path + sha256 hash), and a "why this fired"
 * expander containing the raw JSON excerpt that produced the verdict. Every
 * finding is traceable to its exact snapshot source — the architectural answer
 * to feasibility risk #1 (hallucinated control mapping) and the Vanta complaint
 * about checks that "don't capture everything accurately".
 *
 * Server component — the expander is a native <details> element, so there is no
 * client JS. On load it re-seeds + re-runs the deterministic mapper so the view
 * reflects the latest collected snapshots.
 */

import type { JSX } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";
import { resolveOrgId } from "@/lib/soc2/connectors/snapshot";
import {
  seedCatalog,
  getControl,
  type ControlStatus,
  type RuleStatus,
  type RuleRow,
} from "@/lib/soc2/controls/catalog";
import { runMapping } from "@/lib/soc2/controls/mapper";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CONTROL_STATUS_META: Record<ControlStatus, { label: string; color: string }> = {
  compliant: { label: "Compliant", color: "#0a7d33" },
  in_progress: { label: "In Progress", color: "#9a6a00" },
  deficient: { label: "Deficient", color: "#8a1c1c" },
  not_started: { label: "Not Started", color: "#555" },
};

const RULE_STATUS_META: Record<RuleStatus, { label: string; color: string }> = {
  pass: { label: "Pass", color: "#0a7d33" },
  fail: { label: "Fail", color: "#8a1c1c" },
  not_evaluated: { label: "No evidence yet", color: "#555" },
};

function Pill({ label, color }: { label: string; color: string }): JSX.Element {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: "#fff",
        background: color,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function RuleBlock({ rule }: { rule: RuleRow }): JSX.Element {
  const meta = RULE_STATUS_META[rule.status];
  const artifact = rule.artifact;
  const excerptJson = artifact ? JSON.stringify(artifact.excerpt ?? {}, null, 2) : "";
  return (
    <div className="card" style={{ marginTop: 14, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <strong>{rule.title}</strong>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            {rule.description}
          </p>
        </div>
        <Pill label={meta.label} color={meta.color} />
      </div>

      <p className="muted" style={{ marginTop: 10, marginBottom: 4, fontSize: 13 }}>
        Source: {rule.provider} · {rule.resourceType} · severity {rule.severity}
      </p>

      {rule.rationale && <p style={{ marginTop: 4 }}>{rule.rationale}</p>}

      {artifact ? (
        <>
          <p className="muted" style={{ marginBottom: 4, fontSize: 13 }}>
            Matched snapshot path{" "}
            <code>{artifact.jsonPath}</code>
            {artifact.collectedAt
              ? ` · collected ${new Date(artifact.collectedAt).toLocaleString()}`
              : ""}
          </p>
          <p
            className="muted"
            title={`sha256:${artifact.sha256}`}
            style={{ marginTop: 0, marginBottom: 8, fontSize: 12, fontFamily: "monospace" }}
          >
            evidence hash sha256:{artifact.sha256.slice(0, 16)}… (hover for full)
          </p>
          <details>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>Why this fired</summary>
            <pre
              style={{
                overflowX: "auto",
                padding: 12,
                borderRadius: 6,
                border: "1px solid rgba(0,0,0,0.12)",
                fontSize: 12,
                marginTop: 8,
              }}
            >
              {excerptJson}
            </pre>
          </details>
        </>
      ) : (
        <p className="muted" style={{ fontSize: 13 }}>
          No snapshot for this resource type has been collected yet — connect the
          source and run a pull to evidence this rule.
        </p>
      )}
    </div>
  );
}

export default async function ControlDetailPage({
  params,
}: {
  params: { id: string };
}): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const orgId = await resolveOrgId(user.id);
  if (!orgId) {
    return (
      <main>
        <h1>Control detail</h1>
        <p>
          You need an organization before a control catalog can be scoped to you.{" "}
          <Link href="/org">Create or join an organization</Link> first.
        </p>
      </main>
    );
  }

  // Keep the view fresh: re-seed + re-evaluate deterministically before reading.
  await seedCatalog(orgId);
  await runMapping(orgId);
  const control = await getControl(orgId, params.id);
  if (!control) notFound();

  const statusMeta = CONTROL_STATUS_META[control.status];
  const passed = control.rules.filter((r) => r.status === "pass").length;
  const failed = control.rules.filter((r) => r.status === "fail").length;

  return (
    <main>
      <p className="muted" style={{ marginBottom: 4 }}>
        <Link href="/controls">← Control catalog</Link>
      </p>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
        <h1 style={{ marginBottom: 4 }}>
          {control.controlKey} · {control.title}
        </h1>
        <Pill label={statusMeta.label} color={statusMeta.color} />
      </div>
      <p>{control.description}</p>
      <p className="muted">
        Family {control.family} · {control.rules.length} deterministic check
        {control.rules.length === 1 ? "" : "s"} · {passed} passing
        {failed > 0 ? ` · ${failed} failing` : ""}
        {control.evaluatedAt
          ? ` · last evaluated ${new Date(control.evaluatedAt).toLocaleString()}`
          : ""}
      </p>

      <h2 style={{ marginTop: 24 }}>Checks &amp; evidence</h2>
      {control.rules.length === 0 ? (
        <div className="empty">
          <p className="muted">This control has no check rules defined.</p>
        </div>
      ) : (
        control.rules.map((rule) => <RuleBlock key={rule.id} rule={rule} />)
      )}
    </main>
  );
}
