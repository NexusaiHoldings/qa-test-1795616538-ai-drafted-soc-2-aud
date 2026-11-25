/**
 * AUTO-RECOVERED table DDL (table-ref-autorecover-001).
 *
 * The integration table-ref gate found these tables queried by apps/web
 * with no creating DDL. Columns are inferred from the SQL the build agents
 * wrote (best-effort, loosely typed) so migrate.ts creates them at deploy
 * and the runtime queries don't 500. Reviewable + replaceable: if a feature
 * later adds a richer hand-written DDL for one of these tables, delete its
 * block here (CREATE TABLE IF NOT EXISTS would otherwise no-op the richer one).
 */

export const RECOVERED_PATH_DDL = `
CREATE TABLE IF NOT EXISTS path (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export const RECOVERED_SKIP_DDL = `
CREATE TABLE IF NOT EXISTS skip (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export const RECOVERED_SOC2_EVIDENCE_LINKS_DDL = `
CREATE TABLE IF NOT EXISTS soc2_evidence_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "artifact_id" uuid,
  "artifact_ref" text,
  "artifact_type" text,
  "control_id" uuid,
  "linked_at" timestamptz,
  "organization_id" uuid,
  "status" text,
  "title" text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export const RECOVERED_SOC2_GAP_REPORT_CHANGES_DDL = `
CREATE TABLE IF NOT EXISTS soc2_gap_report_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "await" text,
  "change_type" text,
  "compliant" text,
  "const" text,
  "current_status" text,
  "deficient" text,
  "finding" text,
  "finding_id" uuid,
  "for" text,
  "newly_deficient" text,
  "of" text,
  "organization_id" uuid,
  "pool" text,
  "previous_status" text,
  "query" text,
  "report_id" uuid,
  "resolved" text,
  "rule_id" uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export const RECOVERED_SOC2_GROUNDING_FACTS_DDL = `
CREATE TABLE IF NOT EXISTS soc2_grounding_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "artifact_id" uuid,
  "control_ref" text,
  "fact_key" text,
  "fact_value" text,
  "organization_id" uuid,
  "policy_type" text,
  "sha256" text,
  "snapshot_id" uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export const RECOVERED_SOC2_POLICIES_DDL = `
CREATE TABLE IF NOT EXISTS soc2_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "approved" text,
  "approved_at" timestamptz,
  "organization_id" uuid,
  "policy_type" text,
  "status" text,
  "title" text,
  "version" text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export const RECOVERED_SOC2_POLICY_VERSIONS_DDL = `
CREATE TABLE IF NOT EXISTS soc2_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "approved" text,
  "approved_at" timestamptz,
  "cited_artifact_ids" text,
  "content_hash" text,
  "content_json" jsonb,
  "draft" text,
  "generation_reason" text,
  "in_review" text,
  "int" text,
  "n" text,
  "organization_id" uuid,
  "policy_type" text,
  "requested_by_user_id" uuid,
  "reviewed_at" timestamptz,
  "reviewed_by" text,
  "snapshot_id" uuid,
  "stale" text,
  "stale_at" timestamptz,
  "status" text,
  "summary" text,
  "title" text,
  "version_number" text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export const RECOVERED_THE_DDL = `
CREATE TABLE IF NOT EXISTS the (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;
