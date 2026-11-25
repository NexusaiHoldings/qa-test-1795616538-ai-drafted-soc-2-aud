/**
 * /connect/trust — PUBLIC trust page (F1-002).
 *
 * No auth: this page is deliberately reachable BEFORE signup so a prospect can
 * audit exactly what connecting grants us. It publishes the verbatim read-only
 * IAM policy JSON, the ExternalId-scoped trust policy template, and the complete
 * GitHub App scope list — directly answering the discovery objection "connecting
 * our AWS and GitHub to an unknown startup is itself a security risk."
 */

import type { JSX } from "react";
import Link from "next/link";
import {
  AWS_READONLY_POLICY,
  awsTrustPolicy,
  trustedPrincipalArn,
} from "@/lib/soc2/connectors/aws";
import { GITHUB_READONLY_SCOPES } from "@/lib/soc2/connectors/github";

export const dynamic = "force-static";

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

function ReadOnlyBadge(): JSX.Element {
  return (
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
  );
}

export default function TrustPage(): JSX.Element {
  // A placeholder ExternalId stands in for the per-org value, which is generated
  // after signup and shown on /connect/aws.
  const trust = awsTrustPolicy("soc2-<your-unique-external-id>");

  return (
    <main>
      <h1>What connecting grants us</h1>
      <p>
        Connecting your cloud to a young company should be a security decision,
        not a leap of faith. So here is the complete, exact access we request —
        published before you sign up. Everything below is <strong>read-only</strong>.
        We never store access keys, never get write access, and you can revoke and
        purge all evidence with one click.
      </p>

      <h2>
        AWS — permissions policy <ReadOnlyBadge />
      </h2>
      <p>
        We assume a cross-account IAM role scoped to exactly these actions. Every
        action is a <code>Get</code>, <code>List</code>, or <code>Describe</code>{" "}
        — there is no mutating permission anywhere in the policy.
      </p>
      <CodeBlock id="trust-aws-policy" json={AWS_READONLY_POLICY} />

      <h2>AWS — trust policy</h2>
      <p>
        The role trusts only our principal (<code>{trustedPrincipalArn()}</code>)
        and requires a per-organization <code>ExternalId</code>, so no other
        tenant — and no one who merely guesses your role ARN — can assume it.
      </p>
      <CodeBlock id="trust-aws-trust" json={trust} />

      <h2>GitHub — App scopes</h2>
      <p>
        We install a GitHub App (not a personal access token) with only these
        read-only permissions:
      </p>
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

      <h2>Evidence integrity</h2>
      <p>
        Every pull is validated against a strict schema, stripped of any secret
        material, and stored as an immutable row with a SHA-256 content hash — so
        your auditor can prove evidence was never altered after collection.
      </p>

      <p>
        Ready?{" "}
        <Link className="btn" href="/connect">
          Connect read-only in 10 minutes
        </Link>
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
