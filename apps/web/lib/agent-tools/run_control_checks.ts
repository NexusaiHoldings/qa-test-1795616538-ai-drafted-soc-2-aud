import { createHash } from "node:crypto";
import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";
import { sql } from "@vercel/postgres";

type Args = Record<string, unknown>;

type RuleRow = {
  id: string;
  rule_key: string;
  title: string;
  description: string | null;
  severity: string;
  enabled: boolean;
  eval_sql: string;
};

type SnapshotRow = {
  id: string;
  source: string;
  snapshot_json: unknown;
  captured_at: string;
};

type EvalResultRow = {
  status: string;
  message: string | null;
  evidence: unknown;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asUuid(value: unknown): string | null {
  const v = asString(value);
  if (!v) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v) ? v : null;
}

function stableHash(input: unknown): string {
  const normalized = JSON.stringify(input ?? null);
  return createHash("sha256").update(normalized).digest("hex");
}

export async function handleRunControlChecks(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  try {
    const organizationId =
      asUuid(args.organization_id) ??
      asUuid((ctx as { organizationId?: unknown }).organizationId) ??
      asUuid((ctx as { organization_id?: unknown }).organization_id);

    if (!organizationId) {
      return {
        ok: false,
        error: "invalid_args",
        message: "organization_id is required and must be a UUID",
      };
    }

    const actorUserId =
      asUuid(args.actor_user_id) ??
      asUuid((ctx as { userId?: unknown }).userId) ??
      asUuid((ctx as { user_id?: unknown }).user_id);

    const snapshotsResult = await sql<SnapshotRow>`
      select id, source, snapshot_json, captured_at
      from soc2_snapshots
      where organization_id = ${organizationId}
      order by captured_at desc
      limit 25
    `;

    if (snapshotsResult.rowCount === 0) {
      return {
        ok: true,
        data: {
          organization_id: organizationId,
          scan_id: null,
          findings_created: 0,
          summary: {
            compliant: 0,
            deficient: 0,
            not_applicable: 0,
            error: 0,
          },
          message: "No snapshots available; control checks skipped.",
        },
      };
    }

    const rulesResult = await sql<RuleRow>`
      select id, rule_key, title, description, severity, enabled, eval_sql
      from soc2_check_rules
      where organization_id = ${organizationId}
        and enabled = true
      order by rule_key asc
    `;

    const scanStatus = "completed";
    const nowIso = new Date().toISOString();
    const scanInsert = await sql<{ id: string }>`
      insert into soc2_gap_scans (
        organization_id,
        status,
        started_at,
        completed_at,
        trigger_source,
        triggered_by_user_id
      )
      values (
        ${organizationId},
        ${scanStatus},
        ${nowIso},
        ${nowIso},
        ${"agent_tool_run_control_checks"},
        ${actorUserId}
      )
      returning id
    `;

    const scanId = scanInsert.rows[0]?.id;
    if (!scanId) {
      return {
        ok: false,
        error: "scan_insert_failed",
        message: "Failed to create soc2_gap_scans row",
      };
    }

    let compliant = 0;
    let deficient = 0;
    let notApplicable = 0;
    let errored = 0;
    let findingsCreated = 0;

    for (const rule of rulesResult.rows) {
      let status = "error";
      let message = "Rule evaluation failed";
      let evidence: unknown = null;

      try {
        const evalRows = await sql<EvalResultRow>.unsafe(
          rule.eval_sql,
          [organizationId],
        );
        const first = evalRows.rows[0];

        if (first?.status) {
          status = String(first.status);
        }
        if (first?.message !== undefined && first?.message !== null) {
          message = String(first.message);
        } else if (status === "compliant") {
          message = "Control is compliant";
        } else if (status === "deficient") {
          message = "Control is deficient";
        } else if (status === "not_applicable") {
          message = "Control is not applicable";
        }
        evidence = first?.evidence ?? null;
      } catch (error: unknown) {
        status = "error";
        message =
          error instanceof Error ? error.message.slice(0, 1000) : "Unknown evaluation error";
        evidence = null;
      }

      if (status === "compliant") compliant += 1;
      else if (status === "deficient") deficient += 1;
      else if (status === "not_applicable") notApplicable += 1;
      else errored += 1;

      const evidenceHash = stableHash(evidence);

      await sql`
        insert into soc2_findings (
          organization_id,
          scan_id,
          rule_id,
          rule_key,
          title,
          severity,
          status,
          summary,
          detail,
          evidence_json,
          evidence_hash
        )
        values (
          ${organizationId},
          ${scanId},
          ${rule.id},
          ${rule.rule_key},
          ${rule.title},
          ${rule.severity},
          ${status},
          ${message},
          ${rule.description},
          ${evidence as never},
          ${evidenceHash}
        )
      `;
      findingsCreated += 1;
    }

    await sql`
      update soc2_gap_scans
      set summary_json = ${{
        compliant,
        deficient,
        not_applicable: notApplicable,
        error: errored,
      } as never},
      findings_count = ${findingsCreated}
      where id = ${scanId}
    `;

    return {
      ok: true,
      data: {
        organization_id: organizationId,
        scan_id: scanId,
        findings_created: findingsCreated,
        summary: {
          compliant,
          deficient,
          not_applicable: notApplicable,
          error: errored,
        },
      },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: "run_control_checks_failed",
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
