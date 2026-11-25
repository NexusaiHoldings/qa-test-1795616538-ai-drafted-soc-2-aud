/**
 * /connect — SOC 2 read-only connector registry hub (F1-002).
 *
 * Two provider cards (AWS + GitHub) are the focal point. Each shows a live
 * status pill reflecting the real soc2_connectors row, a one-click revoke (which
 * flips the connector to 'revoked' and purges its snapshots), and a link into
 * the provider's connect flow. A public /connect/trust link answers the "why is
 * connecting to an unknown startup safe?" objection before signup.
 *
 * Server component — the only interactivity is the revoke Server Action.
 */

import type { JSX } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";
import {
  resolveOrgId,
  listConnectors,
  listLatestSnapshots,
  revokeConnector,
  type Connector,
  type Provider,
} from "@/lib/soc2/connectors/snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function StatusPill({ status }: { status: string }): JSX.Element {
  const label =
    status === "connected" ? "Connected" : status === "revoked" ? "Revoked" : "Not connected";
  const bg =
    status === "connected" ? "#0a7d33" : status === "revoked" ? "#8a1c1c" : "#555";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: "#fff",
        background: bg,
      }}
    >
      {label}
    </span>
  );
}

function AwsLogo(): JSX.Element {
  return (
    <svg width="56" height="34" viewBox="0 0 48 29" aria-label="Amazon Web Services" role="img">
      <path
        fill="currentColor"
        d="M13.5 10.6c0 .6.07 1.08.18 1.43.13.35.3.73.52 1.14.08.13.11.25.11.36 0 .15-.09.3-.29.45l-.95.63a.72.72 0 0 1-.39.14c-.15 0-.3-.07-.45-.21a4.6 4.6 0 0 1-.54-.71 11.6 11.6 0 0 1-.46-.89c-1.18 1.39-2.66 2.08-4.44 2.08-1.27 0-2.28-.36-3.02-1.09-.74-.72-1.11-1.69-1.11-2.9 0-1.29.45-2.33 1.37-3.12.91-.79 2.13-1.18 3.68-1.18.51 0 1.04.04 1.6.12.56.08 1.13.2 1.74.34v-1.1c0-1.15-.24-1.95-.71-2.42-.48-.46-1.3-.69-2.47-.69-.53 0-1.08.07-1.64.2-.57.13-1.12.3-1.65.5a4.4 4.4 0 0 1-.54.2.94.94 0 0 1-.24.04c-.21 0-.32-.15-.32-.47v-.74c0-.24.03-.42.1-.53.08-.11.22-.22.43-.32a8.9 8.9 0 0 1 1.92-.68A9.2 9.2 0 0 1 9.4.63c1.77 0 3.06.4 3.89 1.2.82.8 1.23 2.02 1.23 3.65v4.82ZM7.72 12.77c.5 0 1.02-.09 1.56-.27.55-.18 1.03-.52 1.44-.98.24-.29.42-.6.51-.96.09-.36.15-.79.15-1.3v-.62a12.6 12.6 0 0 0-2.84-.33c-.99 0-1.71.19-2.19.59-.48.39-.71.95-.71 1.68 0 .69.17 1.2.53 1.55.35.37.86.55 1.55.55Zm11.44 1.54c-.27 0-.45-.05-.57-.15-.12-.09-.23-.3-.32-.59L14.82 1.76a2.65 2.65 0 0 1-.14-.6c0-.24.12-.37.36-.37h1.48c.28 0 .48.05.59.15.12.09.21.3.3.59l2.4 9.47 2.23-9.47c.08-.3.17-.5.29-.59.12-.1.33-.15.6-.15h1.21c.28 0 .48.05.6.15.12.09.22.3.29.59l2.26 9.58 2.47-9.58c.09-.3.19-.5.3-.59.12-.1.32-.15.59-.15h1.4c.24 0 .37.12.37.37 0 .07-.01.15-.03.24a2.1 2.1 0 0 1-.1.37l-3.56 11.4c-.09.3-.2.5-.32.59-.12.1-.31.15-.57.15h-1.3c-.28 0-.48-.05-.6-.15-.12-.1-.22-.3-.29-.6l-2.22-9.23-2.2 9.22c-.08.3-.17.5-.29.6-.12.1-.33.15-.6.15h-1.31Zm18.3.4c-.74 0-1.48-.09-2.19-.26-.71-.17-1.27-.36-1.64-.57-.23-.13-.38-.27-.44-.4a1 1 0 0 1-.08-.4v-.77c0-.32.12-.47.35-.47.09 0 .18.01.27.04.09.03.22.09.37.15.5.22 1.05.4 1.63.52.58.12 1.16.18 1.75.18.93 0 1.65-.16 2.15-.49.5-.32.76-.79.76-1.4 0-.41-.13-.76-.4-1.04-.26-.28-.76-.54-1.48-.78l-2.13-.66c-1.07-.34-1.86-.84-2.35-1.5a3.5 3.5 0 0 1-.74-2.14c0-.62.13-1.16.4-1.63.26-.47.62-.88 1.07-1.2.45-.33.96-.58 1.56-.75a6.5 6.5 0 0 1 1.89-.26c.32 0 .65.02.97.06.33.04.63.1.93.16.28.07.55.14.8.23.26.09.46.18.6.27.2.12.34.25.42.38.08.13.12.3.12.52v.71c0 .32-.12.49-.35.49a1.6 1.6 0 0 1-.58-.18 6.97 6.97 0 0 0-2.93-.59c-.84 0-1.5.13-1.96.41-.46.27-.69.69-.69 1.28 0 .41.15.76.44 1.04.29.28.84.56 1.62.81l2.09.66c1.05.34 1.81.81 2.26 1.42.45.61.67 1.3.67 2.07 0 .63-.13 1.2-.38 1.7-.26.5-.62.94-1.08 1.29-.46.36-1.01.63-1.65.81-.66.2-1.36.3-2.11.3Z"
      />
    </svg>
  );
}

function GithubLogo(): JSX.Element {
  return (
    <svg width="38" height="38" viewBox="0 0 24 24" aria-label="GitHub" role="img">
      <path
        fill="currentColor"
        d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.75.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.49 5.93.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.21.7.82.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5Z"
      />
    </svg>
  );
}

function byProvider(connectors: Connector[], provider: Provider): Connector | undefined {
  return connectors.find((c) => c.provider === provider);
}

export default async function ConnectPage(): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const orgId = await resolveOrgId(user.id);

  let connectors: Connector[] = [];
  let awsSnapshots = 0;
  let githubSnapshots = 0;
  if (orgId) {
    connectors = await listConnectors(orgId);
    awsSnapshots = (await listLatestSnapshots(orgId, "aws")).length;
    githubSnapshots = (await listLatestSnapshots(orgId, "github")).length;
  }

  const aws = byProvider(connectors, "aws");
  const github = byProvider(connectors, "github");
  const nothingConnected = !aws?.status && !github?.status;

  // Server Action: one-click revoke → flips to 'revoked' + purges snapshots.
  async function revokeAction(formData: FormData): Promise<void> {
    "use server";
    const provider = String(formData.get("provider") || "") as Provider;
    const me = await getSessionUser();
    if (!me) return;
    const org = await resolveOrgId(me.id);
    if (!org || (provider !== "aws" && provider !== "github")) return;
    await revokeConnector(org, provider);
    redirect("/connect");
  }

  return (
    <main>
      <h1>Connect your cloud — read only</h1>
      <p>
        Give your auditor continuous evidence in 10 minutes. We assume a
        read-only AWS role and install a read-only GitHub App — we never store
        access keys and never get write access. See exactly what we read on the{" "}
        <Link href="/connect/trust">public trust page</Link>.
      </p>

      {!orgId && (
        <div className="card">
          <p>
            You need an organization before connecting evidence sources.{" "}
            <Link href="/org">Create or join an organization</Link> first.
          </p>
        </div>
      )}

      {nothingConnected && orgId && (
        <div className="empty">
          <h2>Connect AWS in 10 minutes</h2>
          <p className="muted">
            No evidence sources yet. Start with AWS or GitHub — both are
            read-only and revocable with one click.
          </p>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 20,
          marginTop: 24,
        }}
      >
        <section className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <AwsLogo />
            <h2 style={{ margin: 0 }}>Amazon Web Services</h2>
          </div>
          <p className="muted">
            IAM, MFA, CloudTrail, AWS Config, S3 public access, KMS rotation.
          </p>
          <p>
            Status: <StatusPill status={aws?.status ?? "pending"} />
            {aws?.aws_account_id && (
              <span className="muted"> · account {aws.aws_account_id}</span>
            )}
          </p>
          {aws?.status === "connected" && (
            <p className="muted">
              {awsSnapshots} evidence type{awsSnapshots === 1 ? "" : "s"} captured
              {aws.last_snapshot_at
                ? ` · last pulled ${new Date(aws.last_snapshot_at).toLocaleString()}`
                : " · first pull queued"}
            </p>
          )}
          {aws?.last_error && aws.status !== "connected" && (
            <p style={{ color: "#8a1c1c" }}>Last error: {aws.last_error}</p>
          )}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
            <Link className="btn" href="/connect/aws">
              {aws?.status === "connected" ? "Manage AWS" : "Connect AWS"}
            </Link>
            {aws?.status === "connected" && (
              <form action={revokeAction}>
                <input type="hidden" name="provider" value="aws" />
                <button type="submit" className="btn secondary">
                  Revoke &amp; purge
                </button>
              </form>
            )}
          </div>
        </section>

        <section className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <GithubLogo />
            <h2 style={{ margin: 0 }}>GitHub</h2>
          </div>
          <p className="muted">
            Org members, 2FA enforcement, branch protection, required reviews, PR
            history.
          </p>
          <p>
            Status: <StatusPill status={github?.status ?? "pending"} />
            {github?.github_org_login && (
              <span className="muted"> · {github.github_org_login}</span>
            )}
          </p>
          {github?.status === "connected" && (
            <p className="muted">
              {githubSnapshots} evidence type{githubSnapshots === 1 ? "" : "s"} captured
              {github.last_snapshot_at
                ? ` · last pulled ${new Date(github.last_snapshot_at).toLocaleString()}`
                : " · first pull queued"}
            </p>
          )}
          {github?.last_error && github.status !== "connected" && (
            <p style={{ color: "#8a1c1c" }}>Last error: {github.last_error}</p>
          )}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
            <Link className="btn" href="/connect/github">
              {github?.status === "connected" ? "Manage GitHub" : "Connect GitHub"}
            </Link>
            {github?.status === "connected" && (
              <form action={revokeAction}>
                <input type="hidden" name="provider" value="github" />
                <button type="submit" className="btn secondary">
                  Revoke &amp; purge
                </button>
              </form>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
