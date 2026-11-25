import { NextResponse } from "next/server";
import { runWeeklyGapReports } from "@/lib/soc2/reports/weekly";

export async function GET(): Promise<NextResponse> {
  try {
    const organizationsProcessed = await runWeeklyGapReports();
    return NextResponse.json({ ok: true, organizationsProcessed });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "unknown_error",
      },
      { status: 500 },
    );
  }
}
