/**
 * SOC 2 read-only connector registry schema (F1-002).
 *
 * Company-owned tables for the SOC 2 evidence platform. Every row is scoped by
 * `organization_id` (from @nexus/organizations-and-teams). Snapshots are stored
 * as immutable jsonb with a sha256 content hash for evidence integrity — the
 * deterministic control-evaluation layer reads these rows, never the raw cloud
 * APIs. Picked up by packages/db/migrate.ts via the `*_DDL` convention.
 *
 * Design notes:
 *   - AWS is connected via an STS AssumeRole cross-account role with a per-org
 *     ExternalId — NO long-lived access keys are ever stored. The connector row
 *     holds only the role ARN + ExternalId + account id.
 *   - GitHub is connected via a GitHub App installation — the connector row
 *     holds the installation id + org login, never a user OAuth token.
 *   - Revoke flips `status` to 'revoked' and the snapshot purge deletes evidence
 *     rows for that connector.
 *   - Nightly refresh is chunked through `soc2_ingestion_jobs` so a single
 *     Vercel function never has to pull every resource type at once (mitigates
 *     function-duration limits + API schema volatility).
 */
export const SOC2_DDL = `
CREATE TABLE IF NOT EXISTS soc2_connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  display_name text,
  aws_account_id text,
  aws_role_arn text,
  aws_external_id text,
  github_installation_id text,
  github_org_login text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_snapshot_at timestamptz,
  last_error text,
  connected_at timestamptz,
  revoked_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT soc2_connectors_org_provider_unique UNIQUE (organization_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_soc2_connectors_org
  ON soc2_connectors (organization_id, provider);
CREATE INDEX IF NOT EXISTS idx_soc2_connectors_status
  ON soc2_connectors (status) WHERE status = 'connected';

CREATE TABLE IF NOT EXISTS soc2_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  provider text NOT NULL,
  resource_type text NOT NULL,
  content jsonb NOT NULL,
  content_hash text NOT NULL,
  resource_count integer NOT NULL DEFAULT 0,
  collected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_snapshots_lookup
  ON soc2_snapshots (organization_id, provider, resource_type, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_soc2_snapshots_connector
  ON soc2_snapshots (connector_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_soc2_snapshots_hash
  ON soc2_snapshots (content_hash);

CREATE TABLE IF NOT EXISTS soc2_ingestion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  provider text NOT NULL,
  chunk_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_ingestion_jobs_pending
  ON soc2_ingestion_jobs (scheduled_for) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_soc2_ingestion_jobs_connector
  ON soc2_ingestion_jobs (connector_id, created_at DESC);
`;
