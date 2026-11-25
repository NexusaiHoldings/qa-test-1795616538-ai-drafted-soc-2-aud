import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";
import { query } from "@/lib/db";

type Args = {
  organization_id?: string;
  actor_user_id?: string;
  reason?: string;
  confirm?: boolean;
};

type SnapshotRow = {
  id: string;
  organization_id: string;
  source: string;
  snapshot_json: unknown;
  collected_at: string;
};

type RuleRow = {
  id: string;
  organization_id: string;
  control_id: string;
  title: string;
  description: string | null;
  active: boolean;
  severity: string | null;
  rule_json: unknown;
};

type RulePredicate =
  | { op: "exists"; path: string }
  | { op: "equals"; path: string; value: unknown }
  | { op: "not_equals"; path: string; value: unknown }
  | { op: "in"; path: string; values: unknown[] }
  | { op: "gte"; path: string; value: number }
  | { op: "lte"; path: string; value: number };

type RuleSpec = {
  anyOf?: RulePredicate[];
  allOf?: RulePredicate[];
  source?: string;
};

type FindingInsert = {
  id: string;
  organizationId: string;
  scanId: string;
  checkRuleId: string;
  controlId: string;
  status: "compliant" | "deficient";
  severity: string;
  summary: string;
  evidence: unknown;
};

function getByPath(input: unknown, path: string): unknown {
  if (!path) return input;
  const parts: string[] = path.split(".").filter(Boolean);
  let current: unknown = input;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx: number = Number(part);
      if (Number.isNaN(idx)) return undefined;
      current = current[idx];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function evalPredicate(snapshots: SnapshotRow[], predicate: RulePredicate, source?: string): boolean {
  const scope: SnapshotRow[] = source ? snapshots.filter((s) => s.source === source) : snapshots;
  for (const snapshot of scope) {
    const actual: unknown = getByPath(snapshot.snapshot_json, predicate.path);
    switch (predicate.op) {
      case "exists":
        if (actual !== undefined && actual !== null) return true;
        break;
      case "equals":
        if (actual === predicate.value) return true;
        break;
      case "not_equals":
        if (actual !== undefined && actual !== predicate.value) return true;
        break;
      case "in":
        if (predicate.values.some((v) => v === actual)) return true;
        break;
      case "gte":
        if (typeof actual === "number" && actual >= predicate.value) return true;
        break;
      case "lte":
        if (typeof actual === "number" && actual <= predicate.value) return true;
        break;
      default:
        break;
    }
  }
  return false;
}

function evaluateRule(snapshots: SnapshotRow[], rule: RuleRow): { status: "compliant" | "deficient"; evidence: unknown } {
  const spec: RuleSpec = (rule.rule_json ?? {}) as RuleSpec;
  const anyOf: RulePredicate[] = Array.isArray(spec.anyOf) ? spec.anyOf : [];
  const allOf: RulePredicate[] = Array.isArray(spec.allOf) ? spec.allOf : [];

  const allOfPass: boolean = allOf.every((p) => evalPredicate(snapshots, p, spec.source));
  const anyOfPass: boolean = anyOf.length === 0 ? true : anyOf.some((p) => evalPredicate(snapshots, p, spec.source));
  const pass: boolean = allOfPass && anyOfPass;

  return {
    status: pass ? "compliant" : "deficient",
    evidence: {
      source: spec.source ?? null,
      allOfEvaluated: allOf.length,
      anyOfEvaluated: anyOf.length,
      allOfPass,
      anyOfPass,
    },
  };
}

function normalizeSeverity(value: string | null): string {
  const v: string = (value ?? "").toLowerCase();
  if (v === "low" || v === "medium" || v === "high" || v === "critical") return v;
  return "medium";
}

export async function handleRunControlChecks(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const organizationId: string | undefined = args.organization_id;
  const confirmed: boolean = args.confirm === true;

  if (!organizationId) {
    return {
      ok: false,
      error: "invalid_args",
      message: "organization_id is required",
    };
  }

  if (!confirmed) {
    return {
      ok: false,
      error: "confirmation_required",
      message: "run_control_checks is mutation-class and requires confirm=true",
    };
  }

  const actorUserId: string | null =
    (typeof args.actor_user_id === "string" && args.actor_user_id) ||
    ((ctx as { userId?: string }).userId ?? null);
  const reason: string = typeof args.reason === "string" ? args.reason : "manual_or_automated_trigger";

  const snapshotsResult = await query<SnapshotRow>(
    `
      SELECT id, organization_id, source, snapshot_json, collected_at
      FROM soc2_snapshots
      WHERE organization_id = $1
      ORDER BY collected_at DESC
    `,
    [organizationId],
  );

  const rulesResult = await query<RuleRow>(
    `
      SELECT id, organization_id, control_id, title, description, active, severity, rule_json
      FROM soc2_check_rules
      WHERE organization_id = $1
        AND active = true
      ORDER BY created_at ASC, id ASC
    `,
    [organizationId],
  );

  const snapshots: SnapshotRow[] = snapshotsResult.rows;
  const rules: RuleRow[] = rulesResult.rows;

  const findings: FindingInsert[] = [];
  let compliantCount = 0;
  let deficientCount = 0;

  for (const rule of rules) {
    const evaluated = evaluateRule(snapshots, rule);
    if (evaluated.status === "compliant") {
      compliantCount += 1;
    } else {
      deficientCount += 1;
    }

    findings.push({
      id: randomUUID(),
      organizationId,
      scanId: "",
      checkRuleId: rule.id,
      controlId: rule.control_id,
      status: evaluated.status,
      severity: normalizeSeverity(rule.severity),
      summary:
        evaluated.status === "compliant"
          ? `Control ${rule.control_id} satisfied by deterministic checks`
          : `Control ${rule.control_id} failed deterministic checks`,
      evidence: {
        ...evaluated.evidence,
        snapshotCount: snapshots.length,
        ruleTitle: rule.title,
      },
    });
  }

  const scanSummary = {
    organizationId,
    totalRules: rules.length,
    snapshotsEvaluated: snapshots.length,
    compliantCount,
    deficientCount,
    reason,
    triggeredBy: actorUserId,
  };

  const contentHash: string = createHash("sha256")
    .update(JSON.stringify(scanSummary))
    .digest("hex");

  const scanId: string = randomUUID();

  await query(
    `
      INSERT INTO soc2_gap_scans (
        id,
        organization_id,
        actor_user_id,
        reason,
        status,
        summary_json,
        summary_sha256
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
    `,
    [scanId, organizationId, actorUserId, reason, "completed", JSON.stringify(scanSummary), contentHash],
  );

  for (const finding of findings) {
    finding.scanId = scanId;
    await query(
      `
        INSERT INTO soc2_findings (
          id,
          organization_id,
          scan_id,
          check_rule_id,
          control_id,
          status,
          severity,
          summary,
          evidence_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      `,
      [
        finding.id,
        finding.organizationId,
        finding.scanId,
        finding.checkRuleId,
        finding.controlId,
        finding.status,
        finding.severity,
        finding.summary,
        JSON.stringify(finding.evidence),
      ],
    );
  }

  return {
    ok: true,
    data: {
      scan_id: scanId,
      organization_id: organizationId,
      total_rules: rules.length,
      compliant_count: compliantCount,
      deficient_count: deficientCount,
      findings_created: findings.length,
      summary_sha256: contentHash,
    },
  };
}
