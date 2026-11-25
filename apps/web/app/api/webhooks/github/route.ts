/**
 * POST /api/webhooks/github — GitHub App installation lifecycle (F1-002).
 *
 * External callback (URL-determinism exception). GitHub posts installation
 * events here signed with the App's webhook secret. We verify the HMAC-SHA256
 * signature over the raw body, then react to the installation lifecycle:
 *   - installation.deleted  → revoke + purge the connector's snapshots
 *   - installation.suspend  → mark the connector revoked (evidence pulls stop)
 *   - installation.unsuspend→ re-activate (connector flips back to connected)
 *   - installation created / new_permissions_accepted → refresh org label
 *
 * We NEVER trust the payload for authorization — the signature is the gate, and
 * we only mutate connectors keyed by the installation id GitHub signed.
 */

import { NextResponse } from "next/server";
import { verifyGithubSignature } from "@/lib/soc2/crypto";
import {
  getGithubConnectorByInstallation,
  revokeConnector,
  upsertGithubConnector,
  enqueueIngestionJobs,
} from "@/lib/soc2/connectors/snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface InstallationPayload {
  action?: string;
  installation?: {
    id?: number;
    account?: { login?: string };
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const raw = await request.text();
  const secret = process.env.GITHUB_WEBHOOK_SECRET || "";
  const signature = request.headers.get("x-hub-signature-256");

  // When a secret is configured, the signature MUST validate. If no secret is
  // configured (local/dev) we accept unsigned deliveries.
  if (secret && !verifyGithubSignature(raw, signature, secret)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const event = request.headers.get("x-github-event") || "";
  let payload: InstallationPayload;
  try {
    payload = JSON.parse(raw) as InstallationPayload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (event !== "installation" && event !== "installation_repositories") {
    // Not a lifecycle event we handle — acknowledge so GitHub stops retrying.
    return NextResponse.json({ ok: true, ignored: event });
  }

  const installationId = payload.installation?.id;
  if (!installationId) {
    return NextResponse.json({ ok: true, ignored: "no installation id" });
  }
  const installId = String(installationId);
  const action = payload.action || "";

  const connector = await getGithubConnectorByInstallation(installId);

  try {
    if (action === "deleted" || action === "suspend") {
      if (connector) {
        await revokeConnector(connector.organization_id, "github");
      }
      return NextResponse.json({ ok: true, action, handled: "revoked" });
    }

    if (
      (action === "unsuspend" ||
        action === "created" ||
        action === "new_permissions_accepted" ||
        event === "installation_repositories") &&
      connector
    ) {
      // Re-activate / relabel against the org we already know, then re-queue a
      // pull so evidence reflects the new state.
      const saved = await upsertGithubConnector({
        organizationId: connector.organization_id,
        installationId: installId,
        orgLogin: payload.installation?.account?.login ?? connector.github_org_login,
        createdBy: null,
      });
      await enqueueIngestionJobs(saved);
      return NextResponse.json({ ok: true, action, handled: "refreshed" });
    }

    // created for an installation we have not yet bound to an org is handled by
    // the /connect/github setup callback (which carries the signed state).
    return NextResponse.json({ ok: true, action, handled: "noop" });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message.slice(0, 300) },
      { status: 500 },
    );
  }
}
