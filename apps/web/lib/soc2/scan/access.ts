import { getActiveSubscription } from "@nexus/billing-and-subscriptions";
import { trackEvent } from "@nexus/analytics-and-telemetry";

export type Soc2Tier = "free" | "paid";

export interface Soc2Access {
  tier: Soc2Tier;
  canSeeFullFindings: boolean;
  canSeePolicies: boolean;
  canRunWeekly: boolean;
  findingsLimit: number;
}

export async function getSoc2Access(
  organizationId: string,
  userId: string,
): Promise<Soc2Access> {
  const subscription = await getActiveSubscription({ organizationId });
  const planName = String(subscription?.plan?.slug ?? subscription?.plan?.name ?? "").toLowerCase();
  const isPaid = planName.includes("soc2") || planName.includes("pro") || planName.includes("business");

  return isPaid
    ? {
        tier: "paid",
        canSeeFullFindings: true,
        canSeePolicies: true,
        canRunWeekly: true,
        findingsLimit: Number.MAX_SAFE_INTEGER,
      }
    : {
        tier: "free",
        canSeeFullFindings: false,
        canSeePolicies: false,
        canRunWeekly: false,
        findingsLimit: 3,
      };
}

export async function emitScanStarted(organizationId: string, userId: string, scanId: string): Promise<void> {
  await trackEvent({
    organizationId,
    userId,
    event: "scan_started",
    properties: { scanId },
  });
}

export async function emitScanCompleted(
  organizationId: string,
  userId: string,
  scanId: string,
  score: number,
): Promise<void> {
  await trackEvent({
    organizationId,
    userId,
    event: "scan_completed",
    properties: { scanId, score },
  });
}

export async function emitPaywallViewed(
  organizationId: string,
  userId: string,
  scanId: string,
): Promise<void> {
  await trackEvent({
    organizationId,
    userId,
    event: "paywall_viewed",
    properties: { scanId, cta: "unlock_full_scan_2000_flat" },
  });
}
