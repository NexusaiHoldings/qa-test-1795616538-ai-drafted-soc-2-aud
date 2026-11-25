/**
 * GET /api/cron/soc2-snapshot — nightly read-only evidence refresh (F1-002).
 *
 * Vercel Cron handler. Each invocation:
 *   1. Queues a fresh refresh for every connected connector whose last snapshot
 *      is older than 12h (scheduleNightlyRefresh; deduped against active jobs).
 *   2. Claims a BATCH of due ingestion-job chunks (SKIP LOCKED) and processes
 *      them one resource type at a time — this chunking keeps every invocation
 *      inside the Vercel function duration limit and isolates API schema
 *      volatility to a single chunk (a failing chunk retries on its own).
 *
 * Each processed chunk assumes the AWS role / mints a GitHub installation token,
 * pulls + zod-validates the resources, and persists an immutable, hashed,
 * redacted snapshot row. Completed jobs are marked done; failures retry with
 * backoff until they exhaust their attempts.
 *
 * Auth: when CRON_SECRET is set, Vercel sends `Authorization: Bearer <secret>`;
 * we validate it. Unset (dev) → unguarded.
 */

import { NextResponse } from "next/server";
import {
  scheduleNightlyRefresh,
  claimDueJobs,
  getConnectorById,
  persistSnapshot,
  markJobCompleted,
  markJobFailed,
} from "@/lib/soc2/connectors/snapshot";
import { collectAwsChunk } from "@/lib/soc2/connectors/aws";
import { collectGithubChunk } from "@/lib/soc2/connectors/github";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** Max chunks processed per invocation — bounds function duration. */
const BATCH_SIZE = 8;

function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!cronAuthorized(request)) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const scheduled = await scheduleNightlyRefresh(12);
  const jobs = await claimDueJobs(BATCH_SIZE);

  const results: Array<{ job: string; chunk: string; outcome: string }> = [];

  for (const job of jobs) {
    try {
      const connector = await getConnectorById(job.connector_id);
      if (!connector || connector.status !== "connected") {
        await markJobFailed(job.id, "connector not connected", 99);
        results.push({ job: job.id, chunk: job.chunk_key, outcome: "skipped" });
        continue;
      }

      let collected: { resourceType: string; content: unknown; resourceCount: number };
      if (connector.provider === "aws") {
        if (!connector.aws_role_arn || !connector.aws_external_id) {
          throw new Error("aws connector missing role/external id");
        }
        collected = await collectAwsChunk(
          job.chunk_key,
          connector.aws_role_arn,
          connector.aws_external_id,
        );
      } else {
        if (!connector.github_installation_id) {
          throw new Error("github connector missing installation id");
        }
        collected = await collectGithubChunk(
          job.chunk_key,
          connector.github_installation_id,
          connector.github_org_login,
        );
      }

      await persistSnapshot({
        organizationId: connector.organization_id,
        connectorId: connector.id,
        provider: connector.provider,
        resourceType: collected.resourceType,
        content: collected.content,
        resourceCount: collected.resourceCount,
      });
      await markJobCompleted(job.id);
      results.push({ job: job.id, chunk: job.chunk_key, outcome: "completed" });
    } catch (e) {
      await markJobFailed(job.id, (e as Error).message, job.attempts);
      results.push({ job: job.id, chunk: job.chunk_key, outcome: "failed" });
    }
  }

  return NextResponse.json({
    ok: true,
    scheduled,
    processed: results.length,
    results,
  });
}
