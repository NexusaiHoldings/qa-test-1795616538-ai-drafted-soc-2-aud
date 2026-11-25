/**
 * /connect/github — GitHub App read-only connect flow (F1-002).
 *
 * The customer installs our GitHub App on their org (read-only metadata /
 * members / administration / pull_requests). GitHub's App "Setup URL" is
 * configured to redirect back HERE with ?installation_id&state, so this page
 * doubles as the install callback: when those params are present and the signed
 * state matches the org, we persist the installation as a connected connector
 * and queue the first evidence pull. No user OAuth token is ever stored.
 */

import type { JSX } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";
import { deriveExternalId } from "@/lib/soc2/crypto";
import {
  resolveOrgId,
  getConnector,
  upsertGithubConnector,
  enqueueIngestionJobs,
  listLatestSnapshots,
  GITHUB_CHUNKS,
} from "@/lib/soc2/connectors/snapshot";
import {
  GITHUB_READONLY_SCOPES,
  githubInstallUrl,
  resolveInstallationOrg,
} from "@/lib/soc2/connectors/github";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  searchParams?: {
    installation_id?: string;
    setup_action?: string;
    state?: string;
  };
}

export default async function GithubConnectPage({ searchParams }: PageProps): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const orgId = await resolveOrgId(user.id);
  if (!orgId) {
    return (
      <main>
        <h1>Connect GitHub</h1>
        <div className="card">
          <p>
            You need an organization first.{" "}
            <Link href="/org">Create or join an organization</Link>.
          </p>
        </div>
      </main>
    );
  }

  const state = deriveExternalId(orgId);

  // Install callback: GitHub redirected back with an installation id.
  const installationId = searchParams?.installation_id;
  if (installationId && searchParams?.setup_action !== "cancel") {
    // Verify the signed state belongs to this org (defends against a replayed
    // installation id being bound to the wrong tenant).
    if (searchParams?.state && searchParams.state === state) {
      const { login } = await resolveInstallationOrg(installationId);
      const saved = await upsertGithubConnector({
        organizationId: orgId,
        installationId,
        orgLogin: login,
        createdBy: user.id,
      });
      await enqueueIngestionJobs(saved);
    }
    redirect("/connect/github?connected=1");
  }

  const connector = await getConnector(orgId, "github");
  const connected = connector?.status === "connected";
  const snapshots = connected ? await listLatestSnapshots(orgId, "github") : [];

  return (
    <main>
      <h1>Connect GitHub — read only</h1>
      <p>
        Install our GitHub App on your organization. It requests read-only access
        only — we can never push code, change settings, or merge. The exact scope
        list is published on the <Link href="/connect/trust">trust page</Link>.
      </p>

      <h2>Read-only scopes we request</h2>
      <table>
        <thead>
          <tr>
            <th>Permission</th>
            <th>Access</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {GITHUB_READONLY_SCOPES.map((s) => (
            <tr key={s.scope}>
              <td>
                <code>{s.scope}</code>
              </td>
              <td>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#0a7d33",
                    border: "1px solid #0a7d33",
                    borderRadius: 6,
                    padding: "1px 6px",
                  }}
                >
                  {s.access}-only
                </span>
              </td>
              <td className="muted">{s.why}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {!connected && (
        <p>
          <a className="btn" href={githubInstallUrl(state)}>
            Install the GitHub App
          </a>
        </p>
      )}

      {connected && (
        <div className="card">
          <p>
            <strong>Connected</strong>
            {connector?.github_org_login ? (
              <>
                {" "}
                — <code>{connector.github_org_login}</code> (installation{" "}
                {connector.github_installation_id})
              </>
            ) : null}
            . Evidence pulled:
          </p>
          {snapshots.length === 0 ? (
            <p className="muted">
              First pull queued across {GITHUB_CHUNKS.length} resource types — it
              runs on the next ingestion cycle.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Resource</th>
                  <th>Records</th>
                  <th>Hash</th>
                  <th>Collected</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s.id}>
                    <td>{s.resource_type}</td>
                    <td>{s.resource_count}</td>
                    <td>
                      <code>{s.content_hash.slice(0, 12)}…</code>
                    </td>
                    <td>{new Date(s.collected_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p>
            <a className="btn secondary" href={githubInstallUrl(state)}>
              Reconfigure installation
            </a>
          </p>
        </div>
      )}

      <p>
        <Link href="/connect">← Back to connectors</Link>
      </p>
    </main>
  );
}
