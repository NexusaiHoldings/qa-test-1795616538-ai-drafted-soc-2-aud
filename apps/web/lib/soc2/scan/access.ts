/**
 * SOC 2 free-gap-scan access tier + telemetry (F1-004).
 *
 * Server-only. Two responsibilities:
 *
 *   1. resolveScanAccess() — resolves the signed-in CTO to an organization
 *      (via the org lego's org_members, through resolveOrgId) and reads the
 *      active plan from the billing lego (billing_customers → billing_subscriptions)
 *      to gate the FREE tier (score + top three findings) from the PAID tier
 *      ($2,000/mo flat → full findings, generated policies, weekly runs). Returns
 *      null when there is no live session/org so the pages can render the
 *      "expired role — re-verify" error state instead of throwing.
 *
 *   2. trackScanStarted / trackScanCompleted / trackPaywallViewed — append PLG
 *      funnel events to the analytics lego's analytics_events table. Best-effort:
 *      telemetry failures never block a scan.
 *
 * Uses the same externalized `pg` pool pattern as lib/soc2/connectors/snapshot.ts
 * (pg is a serverComponentsExternalPackage; the pool is lazily created so preview
 * builds without a DB still compile). Every query is parameterized ($1, $2, …).
 */

import { getSessionUser } from "@/lib/admin-auth";
import { resolveOrgId } from "@/lib/soc2/connectors/snapshot";

export type ScanAccessTier = "free" | "paid";

export interface ScanAccess {
  organizationId: string;
  userId: string;
  tier: ScanAccessTier;
  planLabel: string;
  canViewFullFindings: boolean;
  canViewPolicies: boolean;
  canRunWeekly: boolean;
}

/** Subscription statuses that unlock the paid tier. */
const PAID_STATUSES = ["active", "trialing", "past_due"] as const;

interface Pool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pool: any = null;

/** Lazily create the shared pg pool (same pattern as snapshot.ts / mapper.ts). */
export function getScanPool(): Pool {
  if (_pool) return _pool;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (config: Record<string, unknown>) => Pool;
  };
  _pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

/**
 * Resolve the active plan label for a user via the billing lego. Returns the
 * paid tier_name (e.g. 'pro') when an active subscription exists, otherwise
 * 'free'. Swallows DB errors (returns 'free') so an unprovisioned billing table
 * degrades to the free tier rather than 500-ing the scan page.
 */
async function resolvePlanLabel(userId: string): Promise<string> {
  if (!userId) return "free";
  try {
    const { rows } = await getScanPool().query(
      `SELECT s.tier_name
         FROM billing_subscriptions s
         JOIN billing_customers c ON c.id = s.customer_id
        WHERE c.user_id = $1
          AND s.status = ANY($2)
        ORDER BY s.current_period_end DESC NULLS LAST
        LIMIT 1`,
      [userId, PAID_STATUSES as unknown as string[]],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    const tier = row?.tier_name ? String(row.tier_name).trim() : "";
    return tier.length > 0 ? tier : "free";
  } catch {
    return "free";
  }
}

/**
 * Resolve the current scan-access context, or null when the session/org has
 * expired (drives the re-verify error state). A plan other than 'free'/'trial'
 * unlocks the paid tier.
 */
export async function resolveScanAccess(): Promise<ScanAccess | null> {
  const user = await getSessionUser();
  if (!user?.id) return null;

  const organizationId = await resolveOrgId(user.id);
  if (!organizationId) return null;

  const planLabel = await resolvePlanLabel(user.id);
  const normalized = planLabel.toLowerCase();
  const isPaid = normalized !== "free" && normalized !== "trial" && normalized !== "trial_expired";

  return {
    organizationId,
    userId: user.id,
    tier: isPaid ? "paid" : "free",
    planLabel,
    canViewFullFindings: isPaid,
    canViewPolicies: isPaid,
    canRunWeekly: isPaid,
  };
}

/** Append a PLG funnel event to analytics_events. Best-effort — never throws. */
async function emitScanEvent(
  name: string,
  userId: string | null,
  properties: Record<string, unknown>,
): Promise<void> {
  try {
    await getScanPool().query(
      `INSERT INTO analytics_events (name, user_id, properties)
       VALUES ($1, $2, $3::jsonb)`,
      [name, userId, JSON.stringify(properties)],
    );
  } catch {
    // Telemetry is best-effort; a missing table or DB blip must not break a scan.
  }
}

export async function trackScanStarted(
  organizationId: string,
  scanId: string,
  userId: string | null = null,
): Promise<void> {
  await emitScanEvent("scan_started", userId, { organization_id: organizationId, scan_id: scanId });
}

export async function trackScanCompleted(
  organizationId: string,
  scanId: string,
  score: number,
  userId: string | null = null,
): Promise<void> {
  await emitScanEvent("scan_completed", userId, {
    organization_id: organizationId,
    scan_id: scanId,
    score,
  });
}

export async function trackPaywallViewed(
  organizationId: string,
  scanId: string,
  userId: string | null = null,
): Promise<void> {
  await emitScanEvent("paywall_viewed", userId, { organization_id: organizationId, scan_id: scanId });
}
