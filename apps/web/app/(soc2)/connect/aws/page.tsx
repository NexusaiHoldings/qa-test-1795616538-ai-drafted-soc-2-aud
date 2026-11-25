/**
 * /connect/aws — AWS cross-account read-only connect flow (F1-002).
 *
 * A three-step stepper (Create role → Paste ARN → Verify) with inline status
 * pills driven by the real connector state. The customer creates an IAM role
 * trusting our principal + their per-org ExternalId (both shown in a monospace,
 * copyable block carrying a "verified read-only" badge), pastes the role ARN,
 * and the Verify Server Action performs an STS AssumeRole to confirm it — no
 * access keys are ever requested or stored. On success the connector is saved
 * and the first evidence pull is queued.
 */

import type { JSX } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/admin-auth";
import { deriveExternalId } from "@/lib/soc2/crypto";
import {
  resolveOrgId,
  getConnector,
  upsertAwsConnector,
  enqueueIngestionJobs,
  recordConnectorError,
  listLatestSnapshots,
  AWS_CHUNKS,
} from "@/lib/soc2/connectors/snapshot";
import {
  AWS_READONLY_POLICY,
  awsTrustPolicy,
  trustedPrincipalArn,
  verifyAwsRole,
  AWS_REGION,
} from "@/lib/soc2/connectors/aws";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function Pill({ state }: { state: "done" | "active" | "todo" }): JSX.Element {
  const map = {
    done: { label: "Done", bg: "#0a7d33" },
    active: { label: "In progress", bg: "var(--substrate-accent, #4f46e5)" },
    todo: { label: "To do", bg: "#555" },
  } as const;
  const s = map[state];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color: "#fff",
        background: s.bg,
        marginLeft: 8,
      }}
    >
      {s.label}
    </span>
  );
}

function CodeBlock({ id, json }: { id: string; json: unknown }): JSX.Element {
  const text = JSON.stringify(json, null, 2);
  return (
    <div style={{ position: "relative", marginBottom: 16 }}>
      <pre
        id={id}
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 13,
          padding: 16,
          borderRadius: 8,
          border: "1px solid var(--substrate-border, #333)",
          overflowX: "auto",
          whiteSpace: "pre",
        }}
      >
        {text}
      </pre>
      <button
        type="button"
        className="btn secondary"
        data-copy-target={id}
        style={{ position: "absolute", top: 10, right: 10 }}
      >
        Copy
      </button>
    </div>
  );
}

export default async function AwsConnectPage(): Promise<JSX.Element> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const orgId = await resolveOrgId(user.id);
  if (!orgId) {
    return (
      <main>
        <h1>Connect AWS</h1>
        <div className="card">
          <p>
            You need an organization first.{" "}
            <Link href="/org">Create or join an organization</Link>.
          </p>
        </div>
      </main>
    );
  }

  const externalId = deriveExternalId(orgId);
  const connector = await getConnector(orgId, "aws");
  const connected = connector?.status === "connected";
  const snapshots = connected ? await listLatestSnapshots(orgId, "aws") : [];

  const trust = awsTrustPolicy(externalId);

  // Verify Server Action — STS AssumeRole, then persist + queue first pull.
  async function verifyAction(formData: FormData): Promise<void> {
    "use server";
    const me = await getSessionUser();
    if (!me) return;
    const org = await resolveOrgId(me.id);
    if (!org) return;
    const roleArn = String(formData.get("role_arn") || "").trim();
    const extId = deriveExternalId(org);
    if (!/^arn:aws:iam::\d{12}:role\/.+/.test(roleArn)) {
      const existing = await getConnector(org, "aws");
      if (existing) await recordConnectorError(existing.id, "Invalid role ARN format");
      else {
        await upsertAwsConnector({
          organizationId: org,
          roleArn: "",
          externalId: extId,
          accountId: null,
          createdBy: me.id,
        });
        const c = await getConnector(org, "aws");
        if (c) await recordConnectorError(c.id, "Invalid role ARN format");
      }
      redirect("/connect/aws?error=arn");
    }
    const result = await verifyAwsRole(roleArn, extId);
    if (!result.ok) {
      const c =
        (await getConnector(org, "aws")) ??
        (await upsertAwsConnector({
          organizationId: org,
          roleArn,
          externalId: extId,
          accountId: null,
          createdBy: me.id,
        }));
      await recordConnectorError(c.id, result.error || "AssumeRole failed");
      redirect("/connect/aws?error=assume");
    }
    const saved = await upsertAwsConnector({
      organizationId: org,
      roleArn,
      externalId: extId,
      accountId: result.accountId,
      createdBy: me.id,
    });
    await enqueueIngestionJobs(saved);
    redirect("/connect/aws?connected=1");
  }

  const stepCreate: "done" | "active" | "todo" = connected ? "done" : "active";
  const stepPaste: "done" | "active" | "todo" = connected
    ? "done"
    : connector?.aws_role_arn
      ? "active"
      : "todo";
  const stepVerify: "done" | "active" | "todo" = connected ? "done" : "todo";

  return (
    <main>
      <h1>Connect AWS — read only</h1>
      <p>
        Three steps, about ten minutes. We assume a cross-account IAM role scoped
        to the exact read-only policy below — no access keys are ever stored. The
        public <Link href="/connect/trust">trust page</Link> shows every action
        we can take.
      </p>

      <ol style={{ listStyle: "none", paddingLeft: 0 }}>
        <li>
          <strong>1. Create the role</strong>
          <Pill state={stepCreate} />
          <p className="muted">
            In the AWS IAM console create a role for another AWS account. Trust
            this principal and set the ExternalId, then attach the read-only
            policy.
          </p>
          <p>
            Trusted principal:{" "}
            <code>{trustedPrincipalArn()}</code>
          </p>
          <p>
            Your ExternalId: <code>{externalId}</code> · Region:{" "}
            <code>{AWS_REGION}</code>
          </p>
          <p>
            Trust policy{" "}
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
              ✓ scoped to your ExternalId
            </span>
          </p>
          <CodeBlock id="aws-trust-policy" json={trust} />
          <p>
            Permissions policy{" "}
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
              ✓ verified read-only
            </span>
          </p>
          <CodeBlock id="aws-readonly-policy" json={AWS_READONLY_POLICY} />
        </li>

        <li style={{ marginTop: 16 }}>
          <strong>2. Paste the role ARN</strong>
          <Pill state={stepPaste} />
          <p className="muted">
            Copy the new role&apos;s ARN from AWS and paste it below.
          </p>
        </li>

        <li style={{ marginTop: 16 }}>
          <strong>3. Verify</strong>
          <Pill state={stepVerify} />
          <p className="muted">
            We perform a single read-only STS AssumeRole to confirm the trust is
            set up correctly, then queue your first evidence pull.
          </p>
          <form action={verifyAction}>
            <label htmlFor="role_arn">Role ARN</label>
            <input
              id="role_arn"
              name="role_arn"
              type="text"
              placeholder="arn:aws:iam::123456789012:role/NexusSoc2ReadOnly"
              defaultValue={connector?.aws_role_arn ?? ""}
              required
            />
            <button type="submit" className="btn">
              {connected ? "Re-verify role" : "Verify & connect"}
            </button>
          </form>
        </li>
      </ol>

      {connected && (
        <div className="card">
          <p>
            <strong>Connected</strong> — account{" "}
            <code>{connector?.aws_account_id ?? "unknown"}</code>. Evidence pulled:
          </p>
          {snapshots.length === 0 ? (
            <p className="muted">
              First pull queued across {AWS_CHUNKS.length} resource types — it runs
              on the next ingestion cycle.
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
        </div>
      )}

      <p>
        <Link href="/connect">← Back to connectors</Link>
      </p>

      <script
        dangerouslySetInnerHTML={{
          __html: `
document.addEventListener('click', function (e) {
  var t = e.target;
  if (!t || !t.getAttribute) return;
  var id = t.getAttribute('data-copy-target');
  if (!id) return;
  var el = document.getElementById(id);
  if (!el) return;
  var text = el.innerText;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
      var prev = t.innerText; t.innerText = 'Copied'; setTimeout(function () { t.innerText = prev; }, 1500);
    });
  }
});
`,
        }}
      />
    </main>
  );
}
