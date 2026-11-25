/**
 * SOC 2 evidence crypto + redaction helpers (F1-002).
 *
 * Server-only. Every snapshot pulled from a cloud provider is redacted (secret
 * material stripped) and hashed (sha256 over the canonical JSON) BEFORE it is
 * persisted to soc2_snapshots — the hash is the tamper-evidence seal an auditor
 * relies on. Uses the Node `crypto` built-in (no extra dependency).
 */

import { createHash, createHmac, timingSafeEqual } from "crypto";

/** Keys whose VALUES must never be persisted (secret / credential material). */
const REDACT_KEYS = new Set<string>([
  "secretaccesskey",
  "sessiontoken",
  "accesskeyid",
  "password",
  "privatekey",
  "token",
  "secret",
  "clientsecret",
  "authorization",
  "credentials",
  "apikey",
  "api_key",
  "webhooksecret",
]);

const REDACTED = "[REDACTED]";

/**
 * Recursively redact secret-bearing fields from an arbitrary JSON value.
 *
 * Read-only connectors should never surface credentials, but AWS/GitHub API
 * responses occasionally echo ARNs, session tokens or key ids — we strip them
 * defensively so the immutable evidence row can never leak a secret.
 */
export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEYS.has(key.toLowerCase())) {
        out[key] = REDACTED;
      } else {
        out[key] = redact(val);
      }
    }
    return out;
  }
  return value;
}

/**
 * Produce a stable, key-sorted JSON string so the same logical payload always
 * hashes to the same digest regardless of property insertion order.
 */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (val: unknown): unknown => {
    if (val === null || typeof val !== "object") return val;
    if (seen.has(val as object)) return null;
    seen.add(val as object);
    if (Array.isArray(val)) return val.map(normalize);
    const entries = Object.entries(val as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = normalize(v);
    return out;
  };
  return JSON.stringify(normalize(value));
}

/** sha256 hex digest over the canonical JSON representation of `value`. */
export function sha256Json(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** sha256 hex digest over a raw string or buffer. */
export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Generate a per-org ExternalId used in the AWS trust policy. Derived
 * deterministically from the org id + a server secret so the same org always
 * produces the same ExternalId (we can re-render the trust policy) while a
 * caller who only knows the org id cannot forge it.
 */
export function deriveExternalId(organizationId: string): string {
  const secret =
    process.env.SOC2_EXTERNAL_ID_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "soc2-external-id-dev-secret";
  const digest = createHmac("sha256", secret)
    .update(`aws-connect:${organizationId}`)
    .digest("hex");
  return `soc2-${digest.slice(0, 32)}`;
}

/**
 * Verify a GitHub webhook `X-Hub-Signature-256` header against the raw request
 * body using the shared webhook secret. Constant-time comparison.
 */
export function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
