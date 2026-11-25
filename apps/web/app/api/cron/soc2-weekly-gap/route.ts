/**
 * GET /api/cron/soc2-weekly-gap — Monday weekly gap-report run (F1-006).
 *
 * Vercel Cron handler. Re-runs the gap diff for every paid org, writes a
 * soc2_gap_reports row (score delta, newly deficient, resolved), upserts a
 * prioritized soc2_remediation_tasks row per deficient control, scan-verifies
 * resolved ones, and sends the weekly digest via @nexus/notifications.
 *
 * Auth: when CRON_SECRET is set, Vercel sends `Authorization: Bearer <secret>`;
 * we validate it. Unset (dev) → unguarded.
 */

import { NextResponse } from "next/server";
import { runWeeklyGapReports } from "@/lib/soc2/reports/weekly";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!cronAuthorized(request)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  try {
    const organizationsProcessed = await runWeeklyGapReports();
    return NextResponse.json({ ok: true, organizationsProcessed });
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        event: "soc2_weekly_gap_cron_failed",
        error: error instanceof Error ? error.message : "unknown_error",
      }),
    );
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "unknown_error",
      },
      { status: 500 },
    );
  }
}
