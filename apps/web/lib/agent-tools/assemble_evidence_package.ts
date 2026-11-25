import { randomUUID, createHash } from "crypto";
import type { HandlerContext, HandlerResult } from "@nexus/identity-and-access";

type Args = {
  organization_id?: unknown;
  actor_user_id?: unknown;
  requested_at?: unknown;
  confirmation?: unknown;
};

type PolicyRow = {
  id: string;
  organization_id: string;
  policy_type: string;
  title: string;
  version: number;
  status: string;
  approved_at: string | null;
};

type EvidenceLinkRow = {
  id: string;
  organization_id: string;
  control_id: string;
  artifact_id: string;
  artifact_type: string;
  artifact_ref: string;
  title: string;
  status: string;
  linked_at: string | null;
};

type PackageRow = {
  id: string;
  organization_id: string;
  status: string;
  created_at: string;
};

type SqlClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

function isSqlClient(value: unknown): value is SqlClient {
  return Boolean(value) && typeof (value as SqlClient).query === "function";
}

function readSqlClient(ctx: HandlerContext): SqlClient {
  const maybeDb =
    (ctx as unknown as { db?: unknown }).db ??
    (ctx as unknown as { sql?: unknown }).sql ??
    (ctx as unknown as { pg?: unknown }).pg;
  if (!isSqlClient(maybeDb)) {
    throw new Error("Database client missing in handler context");
  }
  return maybeDb;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function hasHumanConfirmation(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "confirm" || v === "confirmed" || v === "yes" || v === "true";
  }
  if (typeof value === "object" && value !== null) {
    const confirmed = (value as { confirmed?: unknown }).confirmed;
    return confirmed === true;
  }
  return false;
}

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function uploadZipViaFilesAndMedia(
  ctx: HandlerContext,
  organizationId: string,
  packageId: string,
  payload: Buffer,
): Promise<{ objectKey: string; sha256: string; bytes: number }> {
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const bytes = payload.byteLength;
  const objectKey = `soc2/${organizationId}/packages/${packageId}/evidence-package-${packageId}.zip`;

  const runtimeUpload = (ctx as unknown as { filesAndMediaUpload?: unknown }).filesAndMediaUpload;
  if (typeof runtimeUpload === "function") {
    await (runtimeUpload as (input: {
      objectKey: string;
      contentType: string;
      body: Buffer;
      metadata: Record<string, string>;
    }) => Promise<void>)({
      objectKey,
      contentType: "application/zip",
      body: payload,
      metadata: {
        package_id: packageId,
        organization_id: organizationId,
        sha256,
      },
    });
  }

  return { objectKey, sha256, bytes };
}

export async function handleAssembleEvidencePackage(
  ctx: HandlerContext,
  args: Args,
): Promise<HandlerResult> {
  const organizationId = readString(args.organization_id);
  const actorUserId = readString(args.actor_user_id);
  const confirmation = hasHumanConfirmation(args.confirmation);

  if (!organizationId) {
    return {
      ok: false,
      error: "invalid_args",
      message: "organization_id is required",
      autonomy: "human_review",
    } as unknown as HandlerResult;
  }

  if (!confirmation) {
    return {
      ok: false,
      error: "confirmation_required",
      message: "assemble_evidence_package is confirm-gated and requires explicit human confirmation",
      autonomy: "human_review",
    } as unknown as HandlerResult;
  }

  const db = readSqlClient(ctx);

  const policyRes = await db.query(
    `
      SELECT id, organization_id, policy_type, title, version, status, approved_at
      FROM soc2_policies
      WHERE organization_id = $1
        AND status = 'approved'
      ORDER BY approved_at DESC NULLS LAST, updated_at DESC NULLS LAST
    `,
    [organizationId],
  );

  const evidenceRes = await db.query(
    `
      SELECT id, organization_id, control_id, artifact_id, artifact_type, artifact_ref, title, status, linked_at
      FROM soc2_evidence_links
      WHERE organization_id = $1
      ORDER BY linked_at DESC NULLS LAST, created_at DESC NULLS LAST
    `,
    [organizationId],
  );

  const approvedPolicies = policyRes.rows as unknown as PolicyRow[];
  const evidenceLinks = evidenceRes.rows as unknown as EvidenceLinkRow[];

  if (approvedPolicies.length === 0) {
    return {
      ok: false,
      error: "no_approved_policies",
      message: "No approved policies found; package cannot be assembled.",
      autonomy: "human_review",
      data: {
        organization_id: organizationId,
      },
    } as unknown as HandlerResult;
  }

  if (evidenceLinks.length === 0) {
    return {
      ok: false,
      error: "no_evidence_links",
      message: "No evidence links found; package cannot be assembled.",
      autonomy: "human_review",
      data: {
        organization_id: organizationId,
      },
    } as unknown as HandlerResult;
  }

  const packageId = randomUUID();
  const nowIso = new Date().toISOString();
  const snapshot = {
    package_id: packageId,
    organization_id: organizationId,
    generated_at: nowIso,
    policies: approvedPolicies,
    evidence_links: evidenceLinks,
  };
  const zipPayload = Buffer.from(toJson(snapshot), "utf8");

  const upload = await uploadZipViaFilesAndMedia(ctx, organizationId, packageId, zipPayload);

  await db.query(
    `
      INSERT INTO soc2_evidence_packages (
        id,
        organization_id,
        status,
        created_by_user_id,
        zip_object_key,
        zip_bytes,
        zip_sha256,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, 'awaiting_release', $3, $4, $5, $6, NOW(), NOW()
      )
    `,
    [packageId, organizationId, actorUserId, upload.objectKey, upload.bytes, upload.sha256],
  );

  for (const policy of approvedPolicies) {
    await db.query(
      `
        INSERT INTO soc2_package_items (
          id,
          organization_id,
          package_id,
          item_kind,
          source_id,
          source_ref,
          title,
          metadata_json,
          created_at
        ) VALUES ($1, $2, $3, 'policy', $4, $5, $6, $7::jsonb, NOW())
      `,
      [
        randomUUID(),
        organizationId,
        packageId,
        policy.id,
        policy.policy_type,
        policy.title,
        JSON.stringify({
          version: policy.version,
          approved_at: policy.approved_at,
        }),
      ],
    );
  }

  for (const ev of evidenceLinks) {
    await db.query(
      `
        INSERT INTO soc2_package_items (
          id,
          organization_id,
          package_id,
          item_kind,
          source_id,
          source_ref,
          title,
          metadata_json,
          created_at
        ) VALUES ($1, $2, $3, 'evidence_link', $4, $5, $6, $7::jsonb, NOW())
      `,
      [
        randomUUID(),
        organizationId,
        packageId,
        ev.id,
        ev.artifact_ref,
        ev.title,
        JSON.stringify({
          control_id: ev.control_id,
          artifact_id: ev.artifact_id,
          artifact_type: ev.artifact_type,
          status: ev.status,
          linked_at: ev.linked_at,
        }),
      ],
    );
  }

  const packageRes = await db.query(
    `
      SELECT id, organization_id, status, created_at
      FROM soc2_evidence_packages
      WHERE id = $1
      LIMIT 1
    `,
    [packageId],
  );
  const createdPackage = (packageRes.rows[0] ?? null) as PackageRow | null;

  return {
    ok: true,
    autonomy: "human_review",
    data: {
      package: createdPackage,
      items_created: approvedPolicies.length + evidenceLinks.length,
      approved_policy_count: approvedPolicies.length,
      evidence_link_count: evidenceLinks.length,
      zip_object_key: upload.objectKey,
      zip_sha256: upload.sha256,
      zip_bytes: upload.bytes,
      requested_at: readString(args.requested_at) ?? nowIso,
    },
  } as unknown as HandlerResult;
}
