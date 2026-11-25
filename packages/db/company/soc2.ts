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

/**
 * SOC 2 TSC control catalog + deterministic evidence mapper schema (F1-003).
 *
 * The deterministic evidence-to-control layer the CEO research direction demands
 * "the LLM cannot override". Four company-owned tables, all scoped by
 * organization_id:
 *
 *   - soc2_controls          — the seeded Trust Services Criteria catalog
 *                              (the five core Common Criteria families in MVP
 *                              scope: CC1, CC5, CC6, CC7, CC8). `status` is a
 *                              derived roll-up of the control's rule verdicts.
 *   - soc2_check_rules       — the deterministic check rules per control
 *                              (e.g. 'root account has hardware MFA'). Each rule
 *                              targets a (provider, resource_type) snapshot and
 *                              carries the latest pass/fail verdict.
 *   - soc2_evidence_artifacts — one row per rule verdict: the exact snapshot id,
 *                              the JSON path inside that snapshot that fired, a
 *                              sha256 integrity hash, and the raw JSON excerpt
 *                              the UI shows in the "why this fired" expander.
 *   - soc2_control_evidence_links — the deterministic link from a control + rule
 *                              to the evidence artifact that satisfies (or
 *                              fails) it. This is the mapping the generative
 *                              layer may describe but never contradict.
 *
 * verdict / status columns are free-form text (no CHECK constraint) by house
 * rule; the application layer owns the allowed-value set. Evaluation is pure
 * TypeScript over the snapshot jsonb — no model is ever in this path.
 */
export const SOC2_CONTROLS_DDL = `
CREATE TABLE IF NOT EXISTS soc2_controls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  control_key text NOT NULL,
  family text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'not_started',
  sort_order integer NOT NULL DEFAULT 0,
  evaluated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT soc2_controls_org_key_unique UNIQUE (organization_id, control_key)
);
CREATE INDEX IF NOT EXISTS idx_soc2_controls_org
  ON soc2_controls (organization_id, family, sort_order);

CREATE TABLE IF NOT EXISTS soc2_check_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  control_id uuid NOT NULL,
  rule_key text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  provider text NOT NULL,
  resource_type text NOT NULL,
  severity text NOT NULL DEFAULT 'high',
  status text NOT NULL DEFAULT 'not_evaluated',
  rationale text,
  sort_order integer NOT NULL DEFAULT 0,
  evaluated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT soc2_check_rules_org_key_unique UNIQUE (organization_id, rule_key)
);
CREATE INDEX IF NOT EXISTS idx_soc2_check_rules_control
  ON soc2_check_rules (control_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_soc2_check_rules_org
  ON soc2_check_rules (organization_id, provider, resource_type);

CREATE TABLE IF NOT EXISTS soc2_evidence_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  snapshot_id uuid,
  provider text NOT NULL,
  resource_type text NOT NULL,
  json_path text NOT NULL,
  sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'not_evaluated',
  excerpt jsonb NOT NULL DEFAULT '{}'::jsonb,
  collected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT soc2_evidence_artifacts_rule_unique UNIQUE (organization_id, rule_id)
);
CREATE INDEX IF NOT EXISTS idx_soc2_evidence_artifacts_org
  ON soc2_evidence_artifacts (organization_id, rule_id);
CREATE INDEX IF NOT EXISTS idx_soc2_evidence_artifacts_snapshot
  ON soc2_evidence_artifacts (snapshot_id);

CREATE TABLE IF NOT EXISTS soc2_control_evidence_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  control_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  artifact_id uuid,
  status text NOT NULL DEFAULT 'not_evaluated',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT soc2_control_evidence_links_rule_unique UNIQUE (organization_id, rule_id)
);
CREATE INDEX IF NOT EXISTS idx_soc2_control_evidence_links_control
  ON soc2_control_evidence_links (control_id);
CREATE INDEX IF NOT EXISTS idx_soc2_control_evidence_links_org
  ON soc2_control_evidence_links (organization_id, control_id);

CREATE TABLE IF NOT EXISTS soc2_gap_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  initiated_by uuid,
  status text NOT NULL DEFAULT 'running',
  score integer NOT NULL DEFAULT 0,
  findings_total integer NOT NULL DEFAULT 0,
  compliant_count integer NOT NULL DEFAULT 0,
  deficient_count integer NOT NULL DEFAULT 0,
  not_assessed_count integer NOT NULL DEFAULT 0,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_gap_scans_org_created
  ON soc2_gap_scans (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS soc2_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  scan_id uuid NOT NULL,
  control_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  artifact_id uuid,
  status text NOT NULL DEFAULT 'not_assessed',
  severity text NOT NULL DEFAULT 'high',
  title text NOT NULL,
  rationale text NOT NULL DEFAULT '',
  provider text NOT NULL,
  resource_type text NOT NULL,
  evidence_link text,
  raw_excerpt jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_findings_scan
  ON soc2_findings (scan_id, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_soc2_findings_org
  ON soc2_findings (organization_id, status, severity);

CREATE TABLE IF NOT EXISTS soc2_gap_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  scan_id uuid NOT NULL,
  previous_scan_id uuid,
  score integer NOT NULL DEFAULT 0,
  previous_score integer NOT NULL DEFAULT 0,
  score_delta integer NOT NULL DEFAULT 0,
  newly_deficient_count integer NOT NULL DEFAULT 0,
  resolved_count integer NOT NULL DEFAULT 0,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  readiness_weeks integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_gap_reports_org_created
  ON soc2_gap_reports (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_soc2_gap_reports_scan
  ON soc2_gap_reports (scan_id);

CREATE TABLE IF NOT EXISTS soc2_remediation_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  control_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  finding_id uuid,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  severity text NOT NULL DEFAULT 'high',
  priority integer NOT NULL DEFAULT 100,
  status text NOT NULL DEFAULT 'todo',
  assignee_user_id uuid,
  due_at timestamptz,
  last_deficient_scan_id uuid,
  verified_scan_id uuid,
  not_applicable boolean NOT NULL DEFAULT false,
  not_applicable_reason text,
  not_applicable_marked_by uuid,
  not_applicable_marked_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT soc2_remediation_tasks_org_rule_unique UNIQUE (organization_id, rule_id)
);
CREATE INDEX IF NOT EXISTS idx_soc2_remediation_tasks_org_status
  ON soc2_remediation_tasks (organization_id, status, priority, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_soc2_remediation_tasks_assignee
  ON soc2_remediation_tasks (organization_id, assignee_user_id, updated_at DESC);
`;

/**
 * S
 */
export const SOC2_REPORTING_DDL = `
CREATE TABLE IF NOT EXISTS soc2_gap_report_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  report_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  change_type text NOT NULL,
  previous_status text,
  current_status text,
  finding_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_soc2_gap_report_changes_report
  ON soc2_gap_report_changes (report_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_soc2_gap_report_changes_org
  ON soc2_gap_report_changes (organization_id, created_at DESC);
`;
