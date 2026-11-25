/**
 * Company-local agent tool: `run_control_checks`.
 *
 * Feature F1-DT001 — confirm-gated mutation (autonomy = autonomous; mutations
 * route through the cross-boundary bridge). Registered in DOMAIN_DISPATCH
 * (apps/web/lib/agent-tools/_dispatch.ts).
 *
 * Evaluates every ENABLED `soc2_check_rules` row for an org against the LATEST
 * snapshot per source (`soc2_snapshots`) and persists one `soc2_gap_scans` row
 * plus a `soc2_findings` row per rule. This is the DETERMINISTIC layer: pure
 * TypeScript predicates over snapshot JSON — NO LLM, NO arbitrary stored SQL in
 * the loop. Every Compliant / Deficient verdict and every evidence→control link
 * is owned here so the generative policy layer can never override a verdict.
 *
 * Called by the weekly gap cron (apps/web/app/api/cron/soc2-weekly-gap) and
 * after any new snapshot ingestion.
 *
 * DB access uses the lego HandlerContext `ctx.db` (pg-backed; $1,$2 params,
 * never string interpolation). Every row is scoped by organization_id.
 */

import { createHash } from "node:crypto";
import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = Record<string, unknown>;

type FindingStatus = "compliant" | "deficient" | "not_applicable" | "error";

interface RuleRow {
  id: string;
  rule_key: string;
  control_ref: string | null;
  title: string;
  description: string | null;
  severity: string | null;
  check_type: string | null;
  config_json: unknown;
  enabled: boolean;
}

interface SnapshotRow {
  id: string;
  source: string;
  snapshot_json: unknown;
  content_hash: string | null;
  captured_at: string;
}

interface EvalOutcome {
  status: FindingStatus;
  summary: string;
  detail: string | null;
  evidence: Record<string, unknown>;
}

/** Trim a value to a non-empty string, else null. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** RFC-4122 UUID validation (any version). */
function asUuid(value: unknown): string | null {
  const v = asString(value);
  if (!v) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    ? v.toLowerCase()
    : null;
}

/** Deterministic, key-sorted JSON so evidence hashes are stable across runs. */
function canonicalJson(input: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value as object)) return null;
    seen.add(value as object);
    if (Array.isArray(value)) return value.map(normalize);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(normalize(input) ?? null);
}

/** SHA-256 hex of a canonicalized value — evidence-integrity hash. */
function sha256Hex(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

/** Resolve a dot/bracket path (e.g. "iam.users[0].mfa") inside a JSON value. */
function getByPath(root: unknown, path: string | null | undefined): unknown {
  if (!path) return root;
  const segments = String(path)
    .replace(/\[(\w+)\]/g, ".$1")
    .split(".")
    .filter((s) => s.length > 0);
  let cursor: unknown = root;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      cursor = cursor[index];
    } else if (typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

/** Coerce a JSON value to boolean with sensible string handling. */
function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    return ["true", "1", "yes", "enabled", "active", "on"].includes(value.trim().toLowerCase());
  }
  return false;
}

/** Coerce to a finite number, else null. */
function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Compare two numbers by a config operator; defaults to "<=". */
function compareNumeric(observed: number, operator: string, expected: number): boolean {
  switch (operator) {
    case "<":
      return observed < expected;
    case "<=":
      return observed <= expected;
    case ">":
      return observed > expected;
    case ">=":
      return observed >= expected;
    case "==":
    case "=":
      return observed === expected;
    case "!=":
      return observed !== expected;
    default:
      return observed <= expected;
  }
}

/** Age in whole days between an ISO timestamp and now; null if unparseable. */
function ageInDays(value: unknown): number | null {
  const raw = asString(value) ?? (typeof value === "number" ? String(value) : null);
  if (!raw) return null;
  const then = Date.parse(raw);
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  return Math.floor(diffMs / 86_400_000);
}

/** Does a collection item match `{ field, equals }` (or truthy field)? */
function itemMatches(item: unknown, field: string | null, equals: unknown): boolean {
  if (!field) return toBoolean(item);
  const actual = getByPath(item, field);
  if (equals === undefined) return toBoolean(actual);
  return canonicalJson(actual) === canonicalJson(equals);
}

/**
 * Deterministically evaluate one rule against the relevant snapshot.
 * Returns the finding status plus an auditable evidence record.
 */
function evaluateRule(rule: RuleRow, snapshot: SnapshotRow | undefined): EvalOutcome {
  const config =
    rule.config_json && typeof rule.config_json === "object"
      ? (rule.config_json as Record<string, unknown>)
      : {};
  const source = asString(config.source) ?? asString(rule.control_ref) ?? "unknown";
  const path = asString(config.path);
  const checkType = asString(rule.check_type) ?? asString(config.check) ?? "evidence_present";

  const baseEvidence: Record<string, unknown> = {
    source,
    path: path ?? null,
    check_type: checkType,
    snapshot_id: snapshot?.id ?? null,
    snapshot_hash: snapshot?.content_hash ?? null,
    captured_at: snapshot?.captured_at ?? null,
  };

  if (!snapshot) {
    return {
      status: "not_applicable",
      summary: `No ${source} snapshot available to evaluate this control.`,
      detail: `Expected a snapshot from source "${source}" but none was found for the org.`,
      evidence: { ...baseEvidence, observed: null },
    };
  }

  const observed = getByPath(snapshot.snapshot_json, path);
  const evidence: Record<string, unknown> = { ...baseEvidence, observed: observed ?? null };

  switch (checkType) {
    case "evidence_present": {
      const present =
        observed !== undefined &&
        observed !== null &&
        !(typeof observed === "string" && observed.trim().length === 0) &&
        !(Array.isArray(observed) && observed.length === 0);
      return {
        status: present ? "compliant" : "deficient",
        summary: present
          ? `Evidence found at ${source}:${path ?? "/"}.`
          : `No evidence found at ${source}:${path ?? "/"}.`,
        detail: null,
        evidence,
      };
    }

    case "boolean_flag": {
      const expected = config.expected === undefined ? true : toBoolean(config.expected);
      const actual = toBoolean(observed);
      const pass = actual === expected;
      evidence.expected = expected;
      return {
        status: pass ? "compliant" : "deficient",
        summary: pass
          ? `${source}:${path ?? "/"} is ${expected} as required.`
          : `${source}:${path ?? "/"} is ${actual}; expected ${expected}.`,
        detail: null,
        evidence,
      };
    }

    case "numeric_threshold": {
      const value = toNumber(observed);
      const threshold = toNumber(config.value ?? config.threshold) ?? 0;
      const operator = asString(config.operator) ?? "<=";
      evidence.operator = operator;
      evidence.threshold = threshold;
      if (value === null) {
        return {
          status: "deficient",
          summary: `${source}:${path ?? "/"} is not a number; cannot satisfy threshold.`,
          detail: null,
          evidence,
        };
      }
      const pass = compareNumeric(value, operator, threshold);
      return {
        status: pass ? "compliant" : "deficient",
        summary: `${source}:${path ?? "/"} = ${value} (needs ${operator} ${threshold}).`,
        detail: null,
        evidence,
      };
    }

    case "max_age_days": {
      const maxAge = toNumber(config.max_age_days ?? config.value) ?? 90;
      const age = ageInDays(observed);
      evidence.max_age_days = maxAge;
      evidence.age_days = age;
      if (age === null) {
        return {
          status: "deficient",
          summary: `${source}:${path ?? "/"} has no parseable timestamp.`,
          detail: null,
          evidence,
        };
      }
      const pass = age <= maxAge;
      return {
        status: pass ? "compliant" : "deficient",
        summary: `${source}:${path ?? "/"} is ${age}d old (max ${maxAge}d).`,
        detail: null,
        evidence,
      };
    }

    case "collection_all": {
      const field = asString(config.field);
      const equals = config.equals;
      const items = Array.isArray(observed) ? observed : [];
      const violations = items.filter((item) => !itemMatches(item, field, equals));
      evidence.total = items.length;
      evidence.violations = violations.length;
      evidence.violation_sample = violations.slice(0, 5);
      const pass = violations.length === 0;
      return {
        status: pass ? "compliant" : "deficient",
        summary: pass
          ? `All ${items.length} ${source} item(s) satisfy ${field ?? "the"} requirement.`
          : `${violations.length} of ${items.length} ${source} item(s) fail ${field ?? "the"} requirement.`,
        detail: null,
        evidence,
      };
    }

    case "collection_none": {
      const field = asString(config.field);
      const equals = config.equals;
      const items = Array.isArray(observed) ? observed : [];
      const matches = items.filter((item) => itemMatches(item, field, equals));
      evidence.total = items.length;
      evidence.matches = matches.length;
      evidence.match_sample = matches.slice(0, 5);
      const pass = matches.length === 0;
      return {
        status: pass ? "compliant" : "deficient",
        summary: pass
          ? `No ${source} item violates ${field ?? "the"} rule (${items.length} checked).`
          : `${matches.length} of ${items.length} ${source} item(s) violate ${field ?? "the"} rule.`,
        detail: null,
        evidence,
      };
    }

    case "equals": {
      const expected = config.value ?? config.expected;
      const pass = canonicalJson(observed) === canonicalJson(expected);
      evidence.expected = expected ?? null;
      return {
        status: pass ? "compliant" : "deficient",
        summary: pass
          ? `${source}:${path ?? "/"} equals the required value.`
          : `${source}:${path ?? "/"} does not equal the required value.`,
        detail: null,
        evidence,
      };
    }

    default: {
      return {
        status: "error",
        summary: `Unknown check_type "${checkType}"; rule could not be evaluated.`,
        detail: `Supported: evidence_present, boolean_flag, numeric_threshold, max_age_days, collection_all, collection_none, equals.`,
        evidence,
      };
    }
  }
}

/**
 * Agent-tool handler. Signature matches lego handlers:
 * `(ctx, args) => Promise<HandlerResult>`.
 */
export async function handleRunControlChecks(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const organizationId = asUuid(args.organization_id) ?? asUuid(args.organizationId);
  if (!organizationId) {
    return { status: 400, body: "organization_id is required and must be a UUID" };
  }
  const actorUserId = asUuid(args.actor_user_id) ?? asUuid(args.actorUserId);
  const triggerSource = asString(args.trigger_source) ?? "agent_tool_run_control_checks";

  try {
    // Latest snapshot per source for this org.
    const snapshots = await ctx.db.query<SnapshotRow>(
      `SELECT DISTINCT ON (source)
              id, source, snapshot_json, content_hash, captured_at
         FROM soc2_snapshots
        WHERE organization_id = $1
        ORDER BY source, captured_at DESC`,
      organizationId,
    );

    const snapshotBySource = new Map<string, SnapshotRow>();
    for (const snap of snapshots) snapshotBySource.set(snap.source, snap);

    if (snapshots.length === 0) {
      return {
        status: 200,
        body: {
          organization_id: organizationId,
          scan_id: null,
          findings_created: 0,
          summary: { compliant: 0, deficient: 0, not_applicable: 0, error: 0 },
          coverage_score: null,
          message: "No snapshots available; control checks skipped.",
        },
      };
    }

    const rules = await ctx.db.query<RuleRow>(
      `SELECT id, rule_key, control_ref, title, description, severity,
              check_type, config_json, enabled
         FROM soc2_check_rules
        WHERE organization_id = $1
          AND enabled = true
        ORDER BY control_ref NULLS LAST, rule_key`,
      organizationId,
    );

    // Open the scan row first so findings can reference it.
    const scanRows = await ctx.db.query<{ id: string }>(
      `INSERT INTO soc2_gap_scans
         (organization_id, status, trigger_source, triggered_by_user_id, started_at)
       VALUES ($1, $2, $3, $4, now())
       RETURNING id`,
      organizationId,
      "running",
      triggerSource,
      actorUserId,
    );
    const scanId = scanRows[0]?.id;
    if (!scanId) {
      return { status: 500, body: "Failed to create soc2_gap_scans row" };
    }

    const counts: Record<FindingStatus, number> = {
      compliant: 0,
      deficient: 0,
      not_applicable: 0,
      error: 0,
    };
    let findingsCreated = 0;

    for (const rule of rules) {
      const configSource =
        rule.config_json && typeof rule.config_json === "object"
          ? asString((rule.config_json as Record<string, unknown>).source)
          : null;
      const source = configSource ?? asString(rule.control_ref) ?? "unknown";
      const snapshot = snapshotBySource.get(source);

      let outcome: EvalOutcome;
      try {
        outcome = evaluateRule(rule, snapshot);
      } catch (error: unknown) {
        outcome = {
          status: "error",
          summary: "Rule evaluation threw an exception.",
          detail: error instanceof Error ? error.message.slice(0, 1000) : "Unknown error",
          evidence: { source, rule_key: rule.rule_key },
        };
      }

      counts[outcome.status] += 1;
      const evidenceHash = sha256Hex(outcome.evidence);

      await ctx.db.execute(
        `INSERT INTO soc2_findings
           (organization_id, scan_id, rule_id, rule_key, control_ref, title,
            severity, status, summary, detail, evidence_json, evidence_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, now())`,
        organizationId,
        scanId,
        rule.id,
        rule.rule_key,
        rule.control_ref,
        rule.title,
        rule.severity ?? "medium",
        outcome.status,
        outcome.summary,
        outcome.detail,
        JSON.stringify(outcome.evidence),
        evidenceHash,
      );
      findingsCreated += 1;
    }

    const evaluated = counts.compliant + counts.deficient;
    const coverageScore = evaluated > 0 ? Math.round((counts.compliant / evaluated) * 100) : null;

    const summary = {
      compliant: counts.compliant,
      deficient: counts.deficient,
      not_applicable: counts.not_applicable,
      error: counts.error,
      coverage_score: coverageScore,
    };

    await ctx.db.execute(
      `UPDATE soc2_gap_scans
          SET status = $2,
              completed_at = now(),
              findings_count = $3,
              compliant_count = $4,
              deficient_count = $5,
              coverage_score = $6,
              summary_json = $7::jsonb
        WHERE id = $1`,
      scanId,
      "completed",
      findingsCreated,
      counts.compliant,
      counts.deficient,
      coverageScore,
      JSON.stringify(summary),
    );

    // Fire-and-forget domain event for downstream analytics / remediation.
    await ctx.events.publish("soc2.gap_scan.completed", {
      organization_id: organizationId,
      scan_id: scanId,
      findings_created: findingsCreated,
      coverage_score: coverageScore,
      trigger_source: triggerSource,
    });

    return {
      status: 200,
      body: {
        organization_id: organizationId,
        scan_id: scanId,
        findings_created: findingsCreated,
        summary,
        coverage_score: coverageScore,
      },
    };
  } catch (error: unknown) {
    return {
      status: 500,
      body: error instanceof Error ? error.message : "run_control_checks failed",
    };
  }
}
