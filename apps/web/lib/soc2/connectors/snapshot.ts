/**
 * SOC 2 connector registry + immutable snapshot persistence (F1-002).
 *
 * Server-only. Owns:
 *   - the connector registry (soc2_connectors) — connect / verify / revoke
 *   - immutable evidence rows (soc2_snapshots) — redact → hash → INSERT
 *   - the chunked nightly refresh queue (soc2_ingestion_jobs)
 *   - org resolution for the signed-in user (via the org lego's org_members)
 *
 * Uses the same externalized `pg` pattern as lib/db.ts (pg is in
 * next.config.js serverComponentsExternalPackages; the pool is created at first
 * call so preview builds without a DB still compile). All queries are
 * parameterized ($1, $2, …) — never string-interpolated.
 */

import { redact, sha256Json } from "@/lib/soc2/crypto";

export type Provider = "aws" | "github";
export type ConnectorStatus = "pending" | "connected" | "revoked";
export type JobStatus = "queued" | "running" | "completed" | "failed";

/** Resource chunks collected per provider — one ingestion job per chunk. */
export const AWS_CHUNKS = ["iam", "cloudtrail", "config", "s3", "kms"] as const;
export const GITHUB_CHUNKS = ["members", "branch_protection", "pull_requests"] as const;

export interface Connector {
  id: string;
  organization_id: string;
  provider: Provider;
  status: ConnectorStatus;
  display_name: string | null;
  aws_account_id: string | null;
  aws_role_arn: string | null;
  aws_external_id: string | null;
  github_installation_id: string | null;
  github_org_login: string | null;
  metadata: Record<string, unknown>;
  last_snapshot_at: string | null;
  last_error: string | null;
  connected_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SnapshotSummary {
  id: string;
  provider: Provider;
  resource_type: string;
  content_hash: string;
  resource_count: number;
  collected_at: string;
}

export interface IngestionJob {
  id: string;
  organization_id: string;
  connector_id: string;
  provider: Provider;
  chunk_key: string;
  status: JobStatus;
  attempts: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pool: any = null;

function getPool(): {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
} {
  if (_pool) return _pool;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (config: Record<string, unknown>) => {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
    };
  };
  _pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

function parseJson(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function mapConnector(row: Record<string, unknown>): Connector {
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    provider: String(row.provider) as Provider,
    status: String(row.status) as ConnectorStatus,
    display_name: row.display_name ? String(row.display_name) : null,
    aws_account_id: row.aws_account_id ? String(row.aws_account_id) : null,
    aws_role_arn: row.aws_role_arn ? String(row.aws_role_arn) : null,
    aws_external_id: row.aws_external_id ? String(row.aws_external_id) : null,
    github_installation_id: row.github_installation_id ? String(row.github_installation_id) : null,
    github_org_login: row.github_org_login ? String(row.github_org_login) : null,
    metadata: parseJson(row.metadata),
    last_snapshot_at: row.last_snapshot_at ? String(row.last_snapshot_at) : null,
    last_error: row.last_error ? String(row.last_error) : null,
    connected_at: row.connected_at ? String(row.connected_at) : null,
    revoked_at: row.revoked_at ? String(row.revoked_at) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/**
 * Resolve the organization the signed-in user belongs to. Returns the first
 * org membership (owner/admin first) or null. The org lego owns org_members;
 * we read it to scope every connector by organization_id.
 */
export async function resolveOrgId(userId: string): Promise<string | null> {
  if (!userId) return null;
  try {
    const { rows } = await getPool().query(
      `SELECT org_id
         FROM org_members
        WHERE user_id = $1
        ORDER BY CASE role
                   WHEN 'owner' THEN 0
                   WHEN 'admin' THEN 1
                   WHEN 'member' THEN 2
                   ELSE 3 END,
                 created_at ASC
        LIMIT 1`,
      [userId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? String(row.org_id) : null;
  } catch {
    return null;
  }
}

/** All connectors for an org, keyed by provider. */
export async function listConnectors(organizationId: string): Promise<Connector[]> {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM soc2_connectors WHERE organization_id = $1 ORDER BY provider ASC`,
      [organizationId],
    );
    return (rows as Record<string, unknown>[]).map(mapConnector);
  } catch {
    return [];
  }
}

/** Single connector for an org + provider, or null. */
export async function getConnector(
  organizationId: string,
  provider: Provider,
): Promise<Connector | null> {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM soc2_connectors WHERE organization_id = $1 AND provider = $2 LIMIT 1`,
      [organizationId, provider],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapConnector(row) : null;
  } catch {
    return null;
  }
}

export async function getConnectorById(connectorId: string): Promise<Connector | null> {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM soc2_connectors WHERE id = $1 LIMIT 1`,
      [connectorId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapConnector(row) : null;
  } catch {
    return null;
  }
}

export interface UpsertAwsInput {
  organizationId: string;
  roleArn: string;
  externalId: string;
  accountId: string | null;
  displayName?: string | null;
  createdBy?: string | null;
}

/**
 * Create or update the AWS connector after a successful STS verification.
 * Flips status to 'connected' and clears any prior error / revoke timestamp.
 */
export async function upsertAwsConnector(input: UpsertAwsInput): Promise<Connector> {
  const { rows } = await getPool().query(
    `INSERT INTO soc2_connectors
       (organization_id, provider, status, display_name, aws_account_id,
        aws_role_arn, aws_external_id, connected_at, created_by, last_error,
        revoked_at, updated_at)
     VALUES ($1, 'aws', 'connected', $2, $3, $4, $5, now(), $6, NULL, NULL, now())
     ON CONFLICT (organization_id, provider) DO UPDATE SET
       status = 'connected',
       display_name = EXCLUDED.display_name,
       aws_account_id = EXCLUDED.aws_account_id,
       aws_role_arn = EXCLUDED.aws_role_arn,
       aws_external_id = EXCLUDED.aws_external_id,
       connected_at = now(),
       last_error = NULL,
       revoked_at = NULL,
       updated_at = now()
     RETURNING *`,
    [
      input.organizationId,
      input.displayName ?? input.accountId ?? "AWS account",
      input.accountId,
      input.roleArn,
      input.externalId,
      input.createdBy ?? null,
    ],
  );
  return mapConnector(rows[0] as Record<string, unknown>);
}

export interface UpsertGithubInput {
  organizationId: string;
  installationId: string;
  orgLogin: string | null;
  displayName?: string | null;
  createdBy?: string | null;
}

/** Create or update the GitHub connector after an App installation callback. */
export async function upsertGithubConnector(input: UpsertGithubInput): Promise<Connector> {
  const { rows } = await getPool().query(
    `INSERT INTO soc2_connectors
       (organization_id, provider, status, display_name, github_installation_id,
        github_org_login, connected_at, created_by, last_error, revoked_at, updated_at)
     VALUES ($1, 'github', 'connected', $2, $3, $4, now(), $5, NULL, NULL, now())
     ON CONFLICT (organization_id, provider) DO UPDATE SET
       status = 'connected',
       display_name = EXCLUDED.display_name,
       github_installation_id = EXCLUDED.github_installation_id,
       github_org_login = EXCLUDED.github_org_login,
       connected_at = now(),
       last_error = NULL,
       revoked_at = NULL,
       updated_at = now()
     RETURNING *`,
    [
      input.organizationId,
      input.displayName ?? input.orgLogin ?? "GitHub organization",
      input.installationId,
      input.orgLogin,
      input.createdBy ?? null,
    ],
  );
  return mapConnector(rows[0] as Record<string, unknown>);
}

/** Find the GitHub connector by installation id (webhook lifecycle). */
export async function getGithubConnectorByInstallation(
  installationId: string,
): Promise<Connector | null> {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM soc2_connectors
        WHERE provider = 'github' AND github_installation_id = $1
        LIMIT 1`,
      [installationId],
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapConnector(row) : null;
  } catch {
    return null;
  }
}

/** Record a connector error without changing its status. */
export async function recordConnectorError(
  connectorId: string,
  message: string,
): Promise<void> {
  try {
    await getPool().query(
      `UPDATE soc2_connectors SET last_error = $2, updated_at = now() WHERE id = $1`,
      [connectorId, message.slice(0, 1000)],
    );
  } catch {
    /* best-effort */
  }
}

/**
 * One-click revoke: flip the connector to 'revoked' and PURGE all evidence
 * snapshots + pending ingestion jobs for it. Returns the number of purged
 * snapshot rows.
 */
export async function revokeConnector(
  organizationId: string,
  provider: Provider,
): Promise<{ revoked: boolean; purgedSnapshots: number }> {
  const pool = getPool();
  const connector = await getConnector(organizationId, provider);
  if (!connector) return { revoked: false, purgedSnapshots: 0 };

  await pool.query(
    `UPDATE soc2_connectors
        SET status = 'revoked',
            revoked_at = now(),
            github_installation_id = NULL,
            aws_role_arn = NULL,
            updated_at = now()
      WHERE id = $1`,
    [connector.id],
  );
  const purge = await pool.query(
    `DELETE FROM soc2_snapshots WHERE connector_id = $1`,
    [connector.id],
  );
  await pool.query(
    `UPDATE soc2_ingestion_jobs
        SET status = 'failed', last_error = 'connector revoked', updated_at = now()
      WHERE connector_id = $1 AND status IN ('queued', 'running')`,
    [connector.id],
  );
  return { revoked: true, purgedSnapshots: purge.rowCount ?? 0 };
}

export interface PersistSnapshotInput {
  organizationId: string;
  connectorId: string;
  provider: Provider;
  resourceType: string;
  content: unknown;
  resourceCount?: number;
}

/**
 * Redact → hash → INSERT an immutable evidence row. soc2_snapshots is
 * append-only (no UPDATE path) so each nightly pull adds a new hashed row,
 * preserving the full evidence timeline for the auditor.
 */
export async function persistSnapshot(
  input: PersistSnapshotInput,
): Promise<SnapshotSummary> {
  const redacted = redact(input.content);
  const hash = sha256Json(redacted);
  const count =
    input.resourceCount ??
    (Array.isArray((redacted as Record<string, unknown>)?.items)
      ? ((redacted as Record<string, unknown>).items as unknown[]).length
      : 0);

  const { rows } = await getPool().query(
    `INSERT INTO soc2_snapshots
       (organization_id, connector_id, provider, resource_type, content,
        content_hash, resource_count)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     RETURNING id, provider, resource_type, content_hash, resource_count, collected_at`,
    [
      input.organizationId,
      input.connectorId,
      input.provider,
      input.resourceType,
      JSON.stringify(redacted),
      hash,
      count,
    ],
  );
  await getPool().query(
    `UPDATE soc2_connectors SET last_snapshot_at = now(), updated_at = now() WHERE id = $1`,
    [input.connectorId],
  );
  const row = rows[0] as Record<string, unknown>;
  return {
    id: String(row.id),
    provider: String(row.provider) as Provider,
    resource_type: String(row.resource_type),
    content_hash: String(row.content_hash),
    resource_count: Number(row.resource_count ?? 0),
    collected_at: String(row.collected_at),
  };
}

/** Most-recent snapshot per resource_type for a connector (evidence overview). */
export async function listLatestSnapshots(
  organizationId: string,
  provider: Provider,
): Promise<SnapshotSummary[]> {
  try {
    const { rows } = await getPool().query(
      `SELECT DISTINCT ON (resource_type)
              id, provider, resource_type, content_hash, resource_count, collected_at
         FROM soc2_snapshots
        WHERE organization_id = $1 AND provider = $2
        ORDER BY resource_type, collected_at DESC`,
      [organizationId, provider],
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      provider: String(r.provider) as Provider,
      resource_type: String(r.resource_type),
      content_hash: String(r.content_hash),
      resource_count: Number(r.resource_count ?? 0),
      collected_at: String(r.collected_at),
    }));
  } catch {
    return [];
  }
}

/**
 * Queue one ingestion job per resource chunk for a connected connector.
 * Called after a successful connect and by the nightly cron.
 */
export async function enqueueIngestionJobs(connector: Connector): Promise<number> {
  const chunks = connector.provider === "aws" ? AWS_CHUNKS : GITHUB_CHUNKS;
  let created = 0;
  for (const chunk of chunks) {
    try {
      // Skip if an active (queued/running) job already exists for this chunk so
      // a frequently-invoked cron can't pile up duplicate work.
      const res = await getPool().query(
        `INSERT INTO soc2_ingestion_jobs
           (organization_id, connector_id, provider, chunk_key, status, scheduled_for)
         SELECT $1, $2, $3, $4, 'queued', now()
          WHERE NOT EXISTS (
            SELECT 1 FROM soc2_ingestion_jobs
             WHERE connector_id = $2 AND chunk_key = $4 AND status IN ('queued', 'running')
          )`,
        [connector.organization_id, connector.id, connector.provider, chunk],
      );
      created += res.rowCount ?? 0;
    } catch {
      /* best-effort per chunk */
    }
  }
  return created;
}

/**
 * Atomically claim up to `limit` due jobs (status queued/running whose
 * scheduled_for has passed), marking them 'running'. Uses SKIP LOCKED so
 * concurrent cron invocations never process the same chunk twice.
 */
export async function claimDueJobs(limit: number): Promise<IngestionJob[]> {
  try {
    const { rows } = await getPool().query(
      `UPDATE soc2_ingestion_jobs AS j
          SET status = 'running',
              attempts = j.attempts + 1,
              started_at = now(),
              updated_at = now()
        WHERE j.id IN (
          SELECT id FROM soc2_ingestion_jobs
           WHERE status IN ('queued', 'running')
             AND scheduled_for <= now()
             AND attempts < 5
           ORDER BY scheduled_for ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, organization_id, connector_id, provider, chunk_key, status, attempts`,
      [limit],
    );
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      organization_id: String(r.organization_id),
      connector_id: String(r.connector_id),
      provider: String(r.provider) as Provider,
      chunk_key: String(r.chunk_key),
      status: String(r.status) as JobStatus,
      attempts: Number(r.attempts ?? 0),
    }));
  } catch {
    return [];
  }
}

export async function markJobCompleted(jobId: string): Promise<void> {
  await getPool().query(
    `UPDATE soc2_ingestion_jobs
        SET status = 'completed', completed_at = now(), last_error = NULL, updated_at = now()
      WHERE id = $1`,
    [jobId],
  );
}

/**
 * Mark a job failed. If it still has retries left, requeue it with a short
 * backoff instead of leaving it dead so a transient API blip self-heals.
 */
export async function markJobFailed(jobId: string, error: string, attempts: number): Promise<void> {
  const requeue = attempts < 5;
  await getPool().query(
    `UPDATE soc2_ingestion_jobs
        SET status = $2,
            last_error = $3,
            scheduled_for = CASE WHEN $2 = 'queued' THEN now() + interval '15 minutes' ELSE scheduled_for END,
            updated_at = now()
      WHERE id = $1`,
    [jobId, requeue ? "queued" : "failed", error.slice(0, 1000)],
  );
}

/**
 * Queue a refresh for every connected connector that has NOT been snapshotted
 * in the last `olderThanHours` hours. Returns the number of jobs created.
 * enqueueIngestionJobs() dedupes against active jobs so re-invocation is safe.
 */
export async function scheduleNightlyRefresh(olderThanHours = 12): Promise<number> {
  let total = 0;
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM soc2_connectors
        WHERE status = 'connected'
          AND (last_snapshot_at IS NULL
               OR last_snapshot_at < now() - ($1 || ' hours')::interval)`,
      [String(olderThanHours)],
    );
    for (const row of rows as Record<string, unknown>[]) {
      total += await enqueueIngestionJobs(mapConnector(row));
    }
  } catch {
    /* no connectors / no DB */
  }
  return total;
}
