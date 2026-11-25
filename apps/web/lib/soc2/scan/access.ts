import { getServerSession } from "@nexus/identity-and-access";
import { emitEvent } from "@nexus/analytics-and-telemetry";
import { getActiveSubscriptionForOrganization } from "@nexus/billing-and-subscriptions";

export type ScanAccessTier = "free" | "paid";

export type ScanAccessResult = {
  organizationId: string;
  userId: string;
  tier: ScanAccessTier;
  canViewFullFindings: boolean;
  canViewPolicies: boolean;
  canRunWeekly: boolean;
};

export async function requireSoc2ScanAccess(): Promise<ScanAccessResult> {
  const session = await getServerSession();

  if (!session?.user?.id || !session?.organization?.id) {
    throw new Error("Unauthorized");
  }

  const organizationId = session.organization.id as string;
  const userId = session.user.id as string;

  const subscription = await getActiveSubscriptionForOrganization(organizationId);
  const plan = (subscription?.planKey ?? "free").toLowerCase();

  const isPaid = plan !== "free" && plan !== "trial_expired";

  return {
    organizationId,
    userId,
    tier: isPaid ? "paid" : "free",
    canViewFullFindings: isPaid,
    canViewPolicies: isPaid,
    canRunWeekly: isPaid,
  };
}

export async function trackScanStarted(organizationId: string, scanId: string): Promise<void> {
  await emitEvent({
    name: "scan_started",
    organizationId,
    properties: { scanId },
  });
}

export async function trackScanCompleted(organizationId: string, scanId: string, score: number): Promise<void> {
  await emitEvent({
    name: "scan_completed",
    organizationId,
    properties: { scanId, score },
  });
}

export async function trackPaywallViewed(organizationId: string, scanId: string): Promise<void> {
  await emitEvent({
    name: "paywall_viewed",
    organizationId,
    properties: { scanId },
  });
}
