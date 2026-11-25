/**
 * SOC 2 TSC control catalog — static definitions + DB persistence (F1-003).
 *
 * Server-only. Seeds the five core Common Criteria families in MVP scope
 * (ceo_briefing mvp_scope: "five core SOC 2 CC controls") into soc2_controls and
 * the deterministic check rules into soc2_check_rules:
 *
 *   CC1 — Control Environment
 *   CC5 — Control Activities
 *   CC6 — Logical & Physical Access Controls
 *   CC7 — System Operations
 *   CC8 — Change Management
 *
 * The catalog shape here is the single source of truth: `seedCatalog` upserts it
 * per organization (idempotent), `listControls` / `getControl` read it back with
 * the mapper-computed verdicts. Every rule names the (provider, resource_type)
 * snapshot its deterministic evaluator (checks.ts) reads — NO model is ever in
 * this path. Uses the same externalized `pg` pool pattern as snapshot.ts; all
 * queries are parameterized ($1, $2, …).
 */

import type { Provider } from "@/lib/soc2/connectors/snapshot";

export type ControlStatus = "compliant" | "in_progress" | "deficient" | "not_started";
export type RuleStatus = "pass" | "fail" | "not_evaluated";

/** One Common Criteria family header rendered as a group on /controls. */
export interface ControlFamily {
  key: string;
  title: string;
  blurb: string;
}

/** Static definition of a single deterministic check rule under a control. */
export interface RuleDef {
  ruleKey: string;
  title: string;
  description: string;
  provider: Provider;
  resourceType: string;
  severity: "high" | "medium" | "low";
}

/** Static definition of a control + its rules. */
export interface ControlDef {
  controlKey: string;
  family: string;
  title: string;
  description: string;
  rules: RuleDef[];
}

/** A control row read back from the DB, with its evaluated rules + evidence. */
export interface RuleRow {
  id: string;
  controlId: string;
  ruleKey: string;
  title: string;
  description: string;
  provider: Provider;
  resourceType: string;
  severity: string;
  status: RuleStatus;
  rationale: string | null;
  sortOrder: number;
  artifact: EvidenceArtifactRow | null;
}

/** An evidence artifact row — the exact snapshot path + hash a rule matched. */
export interface EvidenceArtifactRow {
  id: string;
  snapshotId: string | null;
  provider: string;
  resourceType: string;
  jsonPath: string;
  sha256: string;
  status: RuleStatus;
  excerpt: unknown;
  collectedAt: string | null;
}

/** A control row read back for the catalog / detail pages. */
export interface ControlRow {
  id: string;
  controlKey: string;
  family: string;
  title: string;
  description: string;
  status: ControlStatus;
  sortOrder: number;
  evaluatedAt: string | null;
  rules: RuleRow[];
}

export const CONTROL_FAMILIES: ControlFamily[] = [
  {
    key: "CC1",
    title: "CC1 · Control Environment",
    blurb: "Governance, accountability and workforce security commitments.",
  },
  {
    key: "CC5",
    title: "CC5 · Control Activities",
    blurb: "Technology-enabled safeguards that enforce policy in infrastructure.",
  },
  {
    key: "CC6",
    title: "CC6 · Logical & Physical Access",
    blurb: "Authentication, key management and data-exposure boundaries.",
  },
  {
    key: "CC7",
    title: "CC7 · System Operations",
    blurb: "Audit logging integrity and continuous configuration monitoring.",
  },
  {
    key: "CC8",
    title: "CC8 · Change Management",
    blurb: "Reviewed, enforced and auditable changes to production code.",
  },
];

/**
 * The canonical MVP catalog. Rule keys are stable identifiers the mapper and
 * checks.ts agree on — never rename one without migrating existing rows.
 */
export const CONTROL_CATALOG: ControlDef[] = [
  {
    controlKey: "CC1.1",
    family: "CC1",
    title: "Organization-wide Multi-Factor Enforcement",
    description:
      "The entity demonstrates a commitment to security by requiring two-factor authentication for every member of the engineering organization.",
    rules: [
      {
        ruleKey: "github_org_2fa_enforced",
        title: "GitHub organization enforces two-factor authentication",
        description:
          "The connected GitHub organization has the org-level 2FA requirement turned on, so no member can push code without a second factor.",
        provider: "github",
        resourceType: "members",
        severity: "high",
      },
    ],
  },
  {
    controlKey: "CC1.4",
    family: "CC1",
    title: "Individual Access Accountability",
    description:
      "Every workforce member accesses systems under an individually attributable identity protected by MFA — no shared or unprotected credentials.",
    rules: [
      {
        ruleKey: "iam_all_users_mfa",
        title: "Every IAM user has an MFA device",
        description:
          "All IAM users in the connected AWS account have at least one MFA device registered, so console access is individually attributable and second-factor protected.",
        provider: "aws",
        resourceType: "iam",
        severity: "high",
      },
    ],
  },
  {
    controlKey: "CC5.2",
    family: "CC5",
    title: "Automated Encryption Key Controls",
    description:
      "Technology control activities are deployed to protect data at rest — customer-managed keys automatically rotate on a schedule.",
    rules: [
      {
        ruleKey: "kms_key_rotation_enabled",
        title: "Customer-managed KMS keys have rotation enabled",
        description:
          "Every customer-managed KMS key has automatic annual key rotation enabled, a deployed technical safeguard over data-at-rest encryption.",
        provider: "aws",
        resourceType: "kms",
        severity: "medium",
      },
    ],
  },
  {
    controlKey: "CC5.3",
    family: "CC5",
    title: "Policy Enforced in Infrastructure",
    description:
      "Security policy is enforced by configuration, not documentation — the account password policy meets the entity's strong-credential standard.",
    rules: [
      {
        ruleKey: "iam_password_policy_strong",
        title: "IAM password policy requires strong passwords",
        description:
          "The account password policy requires a minimum length of at least 14 characters, enforcing the credential standard automatically.",
        provider: "aws",
        resourceType: "iam",
        severity: "medium",
      },
    ],
  },
  {
    controlKey: "CC6.1",
    family: "CC6",
    title: "Privileged (Root) Authentication",
    description:
      "Logical access to the most privileged credential — the AWS account root user — is protected by a hardware multi-factor device.",
    rules: [
      {
        ruleKey: "root_hardware_mfa",
        title: "Root account has hardware MFA",
        description:
          "The AWS account root user has multi-factor authentication enabled, so the break-glass credential cannot be used with a password alone.",
        provider: "aws",
        resourceType: "iam",
        severity: "high",
      },
    ],
  },
  {
    controlKey: "CC6.6",
    family: "CC6",
    title: "External Data-Exposure Boundary",
    description:
      "The entity restricts the flow of data across its boundaries — object storage blocks all forms of public access.",
    rules: [
      {
        ruleKey: "s3_public_access_block",
        title: "S3 buckets block public access",
        description:
          "Every S3 bucket has the full public-access-block configuration enabled (block ACLs, ignore ACLs, block policy, restrict public buckets).",
        provider: "aws",
        resourceType: "s3",
        severity: "high",
      },
    ],
  },
  {
    controlKey: "CC7.1",
    family: "CC7",
    title: "Audit Logging Integrity",
    description:
      "The entity captures a tamper-evident, account-wide audit trail of control-plane activity for detection and investigation.",
    rules: [
      {
        ruleKey: "cloudtrail_multiregion_validation",
        title: "CloudTrail multi-region with log-file validation",
        description:
          "At least one CloudTrail trail is multi-region, actively logging, and has log-file validation enabled so recorded events cannot be silently altered.",
        provider: "aws",
        resourceType: "cloudtrail",
        severity: "high",
      },
    ],
  },
  {
    controlKey: "CC7.2",
    family: "CC7",
    title: "Continuous Configuration Monitoring",
    description:
      "The entity monitors its environment continuously — AWS Config records resource configuration changes without interruption.",
    rules: [
      {
        ruleKey: "config_recorder_recording",
        title: "AWS Config recorder is actively recording",
        description:
          "At least one AWS Config configuration recorder is turned on and recording, providing a continuous change-detection baseline.",
        provider: "aws",
        resourceType: "config",
        severity: "medium",
      },
    ],
  },
  {
    controlKey: "CC8.1",
    family: "CC8",
    title: "Reviewed Code Changes",
    description:
      "Changes to production code are reviewed before release — default branches are protected and require at least one approving review.",
    rules: [
      {
        ruleKey: "branch_requires_review",
        title: "Default branch requires at least one review and status checks",
        description:
          "Every repository's default branch is protected and requires at least one approving pull-request review before a merge is allowed.",
        provider: "github",
        resourceType: "branch_protection",
        severity: "high",
      },
    ],
  },
  {
    controlKey: "CC8.2",
    family: "CC8",
    title: "Change Controls Bind Administrators",
    description:
      "Change-management controls apply to everyone — branch protection is enforced even for repository administrators.",
    rules: [
      {
        ruleKey: "branch_enforce_admins",
        title: "Branch protection is enforced for administrators",
        description:
          "Default-branch protection on every repository is configured to include administrators, so privileged users cannot bypass review.",
        provider: "github",
        resourceType: "branch_protection",
        severity: "medium",
      },
    ],
  },
];

/** Flat index of every rule keyed by ruleKey → its control + definition. */
export const RULE_INDEX: Record<string, { control: ControlDef; rule: RuleDef }> = (() => {
  const index: Record<string, { control: ControlDef; rule: RuleDef }> = {};
  for (const control of CONTROL_CATALOG) {
    for (const rule of control.rules) {
      index[rule.ruleKey] = { control, rule };
    }
  }
  return index;
})();

// ── DB layer ────────────────────────────────────────────────────────────────

interface Pool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pool: any = null;

function getPool(): Pool {
  if (_pool) return _pool;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool: PgPool } = require("pg") as {
    Pool: new (config: Record<string, unknown>) => Pool;
  };
  _pool = new PgPool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  return _pool;
}

function parseJson(raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeControlStatus(raw: unknown): ControlStatus {
  const value = String(raw ?? "not_started");
  if (value === "compliant" || value === "in_progress" || value === "deficient") return value;
  return "not_started";
}

function normalizeRuleStatus(raw: unknown): RuleStatus {
  const value = String(raw ?? "not_evaluated");
  if (value === "pass" || value === "fail") return value;
  return "not_evaluated";
}

/**
 * Idempotently seed the full catalog for an organization. Inserts (or updates
 * the human-facing text of) every control and rule. Safe to call on every page
 * load — ON CONFLICT updates text but never clobbers the mapper-computed
 * `status` columns. Returns the number of controls present.
 */
export async function seedCatalog(organizationId: string): Promise<number> {
  const pool = getPool();
  let controlOrder = 0;
  for (const control of CONTROL_CATALOG) {
    controlOrder += 1;
    const { rows } = await pool.query(
      `INSERT INTO soc2_controls
         (organization_id, control_key, family, title, description, sort_order, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (organization_id, control_key) DO UPDATE SET
         family = EXCLUDED.family,
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         sort_order = EXCLUDED.sort_order,
         updated_at = now()
       RETURNING id`,
      [
        organizationId,
        control.controlKey,
        control.family,
        control.title,
        control.description,
        controlOrder,
      ],
    );
    const controlId = String((rows[0] as Record<string, unknown>).id);

    let ruleOrder = 0;
    for (const rule of control.rules) {
      ruleOrder += 1;
      await pool.query(
        `INSERT INTO soc2_check_rules
           (organization_id, control_id, rule_key, title, description, provider,
            resource_type, severity, sort_order, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         ON CONFLICT (organization_id, rule_key) DO UPDATE SET
           control_id = EXCLUDED.control_id,
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           provider = EXCLUDED.provider,
           resource_type = EXCLUDED.resource_type,
           severity = EXCLUDED.severity,
           sort_order = EXCLUDED.sort_order,
           updated_at = now()`,
        [
          organizationId,
          controlId,
          rule.ruleKey,
          rule.title,
          rule.description,
          rule.provider,
          rule.resourceType,
          rule.severity,
          ruleOrder,
        ],
      );
    }
  }
  return CONTROL_CATALOG.length;
}

function mapArtifact(row: Record<string, unknown> | undefined): EvidenceArtifactRow | null {
  if (!row || !row.artifact_id) return null;
  return {
    id: String(row.artifact_id),
    snapshotId: row.snapshot_id ? String(row.snapshot_id) : null,
    provider: String(row.artifact_provider ?? row.provider ?? ""),
    resourceType: String(row.artifact_resource_type ?? row.resource_type ?? ""),
    jsonPath: String(row.json_path ?? ""),
    sha256: String(row.sha256 ?? ""),
    status: normalizeRuleStatus(row.artifact_status),
    excerpt: parseJson(row.excerpt),
    collectedAt: row.collected_at ? String(row.collected_at) : null,
  };
}

/**
 * Read the full catalog for an org, grouped nowhere (flat, ordered). Each
 * control carries its rules and each rule carries the evidence artifact the
 * mapper linked (if any). Returns [] on any DB error so the page can render an
 * empty / unconnected state instead of 500-ing.
 */
export async function listControls(organizationId: string): Promise<ControlRow[]> {
  try {
    const pool = getPool();
    const controlsRes = await pool.query(
      `SELECT id, control_key, family, title, description, status, sort_order, evaluated_at
         FROM soc2_controls
        WHERE organization_id = $1
        ORDER BY sort_order ASC, control_key ASC`,
      [organizationId],
    );
    const controls = (controlsRes.rows as Record<string, unknown>[]).map((c) => ({
      id: String(c.id),
      controlKey: String(c.control_key),
      family: String(c.family),
      title: String(c.title),
      description: String(c.description ?? ""),
      status: normalizeControlStatus(c.status),
      sortOrder: Number(c.sort_order ?? 0),
      evaluatedAt: c.evaluated_at ? String(c.evaluated_at) : null,
      rules: [] as RuleRow[],
    }));
    if (controls.length === 0) return [];

    const byId = new Map(controls.map((c) => [c.id, c]));
    const rulesRes = await pool.query(
      `SELECT r.id, r.control_id, r.rule_key, r.title, r.description, r.provider,
              r.resource_type, r.severity, r.status, r.rationale, r.sort_order,
              a.id AS artifact_id, a.snapshot_id, a.provider AS artifact_provider,
              a.resource_type AS artifact_resource_type, a.json_path, a.sha256,
              a.status AS artifact_status, a.excerpt, a.collected_at
         FROM soc2_check_rules r
         LEFT JOIN soc2_evidence_artifacts a
           ON a.organization_id = r.organization_id AND a.rule_id = r.id
        WHERE r.organization_id = $1
        ORDER BY r.sort_order ASC, r.rule_key ASC`,
      [organizationId],
    );
    for (const row of rulesRes.rows as Record<string, unknown>[]) {
      const control = byId.get(String(row.control_id));
      if (!control) continue;
      control.rules.push({
        id: String(row.id),
        controlId: String(row.control_id),
        ruleKey: String(row.rule_key),
        title: String(row.title),
        description: String(row.description ?? ""),
        provider: String(row.provider) as Provider,
        resourceType: String(row.resource_type),
        severity: String(row.severity ?? "high"),
        status: normalizeRuleStatus(row.status),
        rationale: row.rationale ? String(row.rationale) : null,
        sortOrder: Number(row.sort_order ?? 0),
        artifact: mapArtifact(row),
      });
    }
    return controls;
  } catch {
    return [];
  }
}

/** Read a single control (by id) with its rules + evidence, or null. */
export async function getControl(
  organizationId: string,
  controlId: string,
): Promise<ControlRow | null> {
  const all = await listControls(organizationId);
  return all.find((c) => c.id === controlId) ?? null;
}

/** Group controls by their family, preserving CONTROL_FAMILIES order. */
export function groupByFamily(
  controls: ControlRow[],
): Array<{ family: ControlFamily; controls: ControlRow[] }> {
  return CONTROL_FAMILIES.map((family) => ({
    family,
    controls: controls.filter((c) => c.family === family.key),
  })).filter((group) => group.controls.length > 0);
}

/** Fraction (0–1) of a family's controls that are compliant — the ring value. */
export function familyProgress(controls: ControlRow[]): number {
  if (controls.length === 0) return 0;
  const compliant = controls.filter((c) => c.status === "compliant").length;
  return compliant / controls.length;
}
