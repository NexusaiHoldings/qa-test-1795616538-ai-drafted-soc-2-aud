/**
 * Weekly SOC 2 gap-report engine (F1-006).
 *
 * Invoked every Monday by the Vercel cron handler
 * (apps/web/app/api/cron/soc2-weekly-gap). For each paid org that has at least
 * one completed scan it:
 *
 *   1. reads the two most-recent completed scans (latest + previous);
 *   2. diffs their DEFICIENT findings by rule_id to compute "newly deficient"
 *      and "resolved" sets — this is a pure set diff over the deterministic
 *      scan output, never a model judgement;
 *   3. writes one immutable soc2_gap_reports row (score, delta, counts,
 *      estimated weeks-to-audit-ready) plus one soc2_gap_report_changes row per
 *      change for the /reports/[id] "what changed" timeline;
 *   4. upserts a prioritized, assignable soc2_remediation_tasks row per still-
 *      deficient control, and — crucially — moves a task to 'verified' ONLY
 *      when the next scan no longer reports its rule as deficient (scan-gated,
 *      never by human assertion);
 *   5. emails + in-app notifies the org's members a digest via @nexus/notifications.
 *
 * DB access reuses the shared `pg` pool from lib/soc2/scan/access (pg is a
 * serverExternalPackage; every query is parameterized).
 */

import { getScanPool } from "@/lib/soc2/scan/access";
import { estimateReadinessWeeks } from "./readiness";
import { buildDb } from "@/lib/db";
import { buildEventBus } from "@/lib/events";
import { handleSendNotification } from "@nexus/notifications";

interface ScanRow {
  id: string;
  score: number;
  deficient_count: number;
  created_at: string;
}

interface DeficientFinding {
  id: string;
  rule_id: string;
  control_id: string;
  severity: string;
  title: string;
  rationale: string;
}

interface OrgDigest {
  organizationId: string;
  reportId: string;
  score: number;
  scoreDelta: number;
  newlyDeficient: number;
  resolved: number;
  readinessWeeks: number;
}

/** Only paid orgs get the weekly run; mirrors ScanAccess.canRunWeekly gating. */
const PAID_STATUSES = ["active", "trialing", "past_due"];

/**
 * Resolve the set of org ids that should receive a weekly run: any org with a
 * connected connector AND an active paid subscription for at least one member.
 * Falls back to "has a connected connector" when billing is unprovisioned so
 * dev/preview environments still produce reports.
 */
async function resolvePaidOrgIds(): Promise<string[]> {
  const pool = getScanPool();
  const { rows } = await pool.query(
    `SELECT DISTINCT c.organization_id
       FROM soc2_connectors c
      WHERE c.status = 'connected'`,
    [],
  );
  const orgIds = (rows as Array<{ organization_id: string }>).map((r) => r.organization_id);
  if (orgIds.length === 0) return [];

  try {
    const { rows: paidRows } = await pool.query(
      `SELECT DISTINCT m.org_id
         FROM org_members m
         JOIN billing_customers bc ON bc.user_id = m.user_id
         JOIN billing_subscriptions bs ON bs.customer_id = bc.id
        WHERE m.org_id = ANY($1)
          AND bs.status = ANY($2)`,
      [orgIds, PAID_STATUSES],
    );
    const paid = (paidRows as Array<{ org_id: string }>).map((r) => r.org_id);
    // If billing returns nothing (unprovisioned), degrade to all connected orgs.
    return paid.length > 0 ? paid : orgIds;
  } catch {
    return orgIds;
  }
}

/** Two most-recent completed scans for an org, newest first. */
async function loadRecentScans(organizationId: string): Promise<ScanRow[]> {
  const { rows } = await getScanPool().query(
    `SELECT id, score, deficient_count, created_at
       FROM soc2_gap_scans
      WHERE organization_id = $1
        AND status = 'completed'
      ORDER BY created_at DESC
      LIMIT 2`,
    [organizationId],
  );
  return rows as ScanRow[];
}

/** Deficient findings for a scan. */
async function loadDeficientFindings(
  organizationId: string,
  scanId: string,
): Promise<DeficientFinding[]> {
  const { rows } = await getScanPool().query(
    `SELECT id, rule_id, control_id, severity, title, rationale
       FROM soc2_findings
      WHERE organization_id = $1
        AND scan_id = $2
        AND status = 'deficient'`,
    [organizationId, scanId],
  );
  return rows as DeficientFinding[];
}

function countSeverities(findings: DeficientFinding[]): {
  high: number;
  medium: number;
  low: number;
} {
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const f of findings) {
    if (f.severity === "high") high += 1;
    else if (f.severity === "medium") medium += 1;
    else low += 1;
  }
  return { high, medium, low };
}

function severityPriority(severity: string): number {
  if (severity === "high") return 10;
  if (severity === "medium") return 50;
  return 90;
}

/**
 * Produce the weekly report + remediation deltas for a single org. Returns the
 * digest payload (for notification) or null when there is nothing to report.
 */
async function processOrg(organizationId: string): Promise<OrgDigest | null> {
  const scans = await loadRecentScans(organizationId);
  if (scans.length === 0) return null;

  const latest = scans[0];
  const previous = scans[1] ?? null;

  const latestDeficient = await loadDeficientFindings(organizationId, latest.id);
  const previousDeficient = previous
    ? await loadDeficientFindings(organizationId, previous.id)
    : [];

  const prevRules = new Set(previousDeficient.map((r) => r.rule_id));
  const currRules = new Set(latestDeficient.map((r) => r.rule_id));

  const newlyDeficient = latestDeficient.filter((r) => !prevRules.has(r.rule_id));
  const resolvedRuleIds = [...prevRules].filter((ruleId) => !currRules.has(ruleId));

  const previousScore = previous ? previous.score : latest.score;
  const scoreDelta = latest.score - previousScore;

  const { high, medium, low } = countSeverities(latestDeficient);
  const readinessWeeks = estimateReadinessWeeks({
    deficientCount: latest.deficient_count,
    highSeverityCount: high,
    mediumSeverityCount: medium,
    lowSeverityCount: low,
  });

  const summary = {
    generatedBy: "cron:soc2-weekly-gap",
    newlyDeficientRules: newlyDeficient.map((r) => r.rule_id),
    resolvedRules: resolvedRuleIds,
    severityMix: { high, medium, low },
  };

  const pool = getScanPool();
  const { rows: reportRows } = await pool.query(
    `INSERT INTO soc2_gap_reports (
       organization_id, scan_id, previous_scan_id, score, previous_score,
       score_delta, newly_deficient_count, resolved_count, summary, readiness_weeks
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
     RETURNING id`,
    [
      organizationId,
      latest.id,
      previous?.id ?? null,
      latest.score,
      previousScore,
      scoreDelta,
      newlyDeficient.length,
      resolvedRuleIds.length,
      JSON.stringify(summary),
      readinessWeeks,
    ],
  );
  const reportId = String((reportRows[0] as { id: string }).id);

  // Timeline rows for /reports/[id].
  for (const finding of newlyDeficient) {
    await pool.query(
      `INSERT INTO soc2_gap_report_changes (
         organization_id, report_id, rule_id, change_type, previous_status, current_status, finding_id
       ) VALUES ($1, $2, $3, 'newly_deficient', 'compliant', 'deficient', $4)`,
      [organizationId, reportId, finding.rule_id, finding.id],
    );
  }
  for (const ruleId of resolvedRuleIds) {
    await pool.query(
      `INSERT INTO soc2_gap_report_changes (
         organization_id, report_id, rule_id, change_type, previous_status, current_status
       ) VALUES ($1, $2, $3, 'resolved', 'deficient', 'compliant')`,
      [organizationId, reportId, ruleId],
    );
  }

  // Upsert a remediation task per still-deficient control. A task that was
  // previously 'verified' but is deficient again is reopened to 'todo'; a task
  // marked not-applicable keeps its status (the auditor justification stands).
  for (const finding of latestDeficient) {
    await pool.query(
      `INSERT INTO soc2_remediation_tasks (
         organization_id, control_id, rule_id, finding_id, title, description,
         severity, priority, status, last_deficient_scan_id, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'todo', $9, now())
       ON CONFLICT (organization_id, rule_id) DO UPDATE SET
         finding_id = EXCLUDED.finding_id,
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         severity = EXCLUDED.severity,
         priority = EXCLUDED.priority,
         last_deficient_scan_id = EXCLUDED.last_deficient_scan_id,
         status = CASE
           WHEN soc2_remediation_tasks.not_applicable THEN soc2_remediation_tasks.status
           WHEN soc2_remediation_tasks.status = 'verified' THEN 'todo'
           ELSE soc2_remediation_tasks.status
         END,
         verified_scan_id = CASE
           WHEN soc2_remediation_tasks.status = 'verified' THEN NULL
           ELSE soc2_remediation_tasks.verified_scan_id
         END,
         updated_at = now()`,
      [
        organizationId,
        finding.control_id,
        finding.rule_id,
        finding.id,
        finding.title,
        finding.rationale ?? "",
        finding.severity,
        severityPriority(finding.severity),
        latest.id,
      ],
    );
  }

  // Scan-gated verification: a rule that was deficient and is no longer flagged
  // flips its task to 'verified'. This is the ONLY path to 'verified' — the UI
  // never lets a human assert it. Not-applicable tasks are left untouched.
  for (const ruleId of resolvedRuleIds) {
    await pool.query(
      `UPDATE soc2_remediation_tasks
          SET status = 'verified',
              verified_scan_id = $3,
              updated_at = now()
        WHERE organization_id = $1
          AND rule_id = $2
          AND not_applicable = false`,
      [organizationId, ruleId, latest.id],
    );
  }

  return {
    organizationId,
    reportId,
    score: latest.score,
    scoreDelta,
    newlyDeficient: newlyDeficient.length,
    resolved: resolvedRuleIds.length,
    readinessWeeks,
  };
}

/** Org members (user_id + email) who should receive the digest. */
async function loadOrgRecipients(
  organizationId: string,
): Promise<Array<{ userId: string; email: string }>> {
  try {
    const { rows } = await getScanPool().query(
      `SELECT m.user_id, u.email
         FROM org_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1
          AND u.status = 'active'
          AND m.role IN ('owner', 'admin', 'member')`,
      [organizationId],
    );
    return (rows as Array<{ user_id: string; email: string }>).map((r) => ({
      userId: String(r.user_id),
      email: String(r.email),
    }));
  } catch {
    return [];
  }
}

function renderDigestHtml(digest: OrgDigest): string {
  const trend =
    digest.scoreDelta > 0
      ? `up ${digest.scoreDelta} points`
      : digest.scoreDelta < 0
        ? `down ${Math.abs(digest.scoreDelta)} points`
        : "unchanged";
  return [
    "<h1>Your weekly SOC 2 gap report</h1>",
    `<p>Coverage score is now <strong>${digest.score}</strong> (${trend} week over week).</p>`,
    "<ul>",
    `<li>${digest.newlyDeficient} newly deficient control(s)</li>`,
    `<li>${digest.resolved} control(s) verified resolved by this scan</li>`,
    `<li>Estimated <strong>${digest.readinessWeeks} week(s)</strong> to audit-ready</li>`,
    "</ul>",
    "<p>This is a re-run of your scan — it replaces manual gap tracking, it doesn't add to it.</p>",
    `<p><a href="/reports/${digest.reportId}">See what changed &rarr;</a></p>`,
  ].join("");
}

/**
 * Best-effort digest to every org member over email + in-app. A failure to
 * notify one recipient never aborts the run (reports are already persisted).
 */
async function sendDigest(digest: OrgDigest): Promise<void> {
  const recipients = await loadOrgRecipients(digest.organizationId);
  if (recipients.length === 0) return;

  const config = {
    default_channels: ["email", "in_app"],
    resend_from_email:
      process.env.NOTIFICATIONS_FROM_EMAIL || process.env.RESEND_FROM_EMAIL || "",
  };
  const html = renderDigestHtml(digest);
  const ctx = { db: buildDb(), events: buildEventBus() };

  for (const recipient of recipients) {
    try {
      await handleSendNotification({
        body: {
          user_id: recipient.userId,
          template_name: "soc2_weekly_gap_digest",
          category: "transactional",
          to_email: recipient.email,
          html_template: html,
          variables: {
            score: digest.score,
            score_delta: digest.scoreDelta,
            readiness_weeks: digest.readinessWeeks,
            report_id: digest.reportId,
          },
        },
        config,
        ctx,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "soc2_weekly_digest_failed",
          organization_id: digest.organizationId,
          user_id: recipient.userId,
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }
}

/**
 * Entry point for the Monday cron. Processes every paid org, persists its
 * report + remediation deltas, and fires the digest. Returns the number of orgs
 * for which a report was written.
 */
export async function runWeeklyGapReports(): Promise<number> {
  const orgIds = await resolvePaidOrgIds();
  let reportsWritten = 0;

  for (const organizationId of orgIds) {
    try {
      const digest = await processOrg(organizationId);
      if (!digest) continue;
      reportsWritten += 1;
      await sendDigest(digest);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "soc2_weekly_gap_org_failed",
          organization_id: organizationId,
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }

  return reportsWritten;
}
