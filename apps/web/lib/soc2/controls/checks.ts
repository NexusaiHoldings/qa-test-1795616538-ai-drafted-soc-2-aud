/**
 * SOC 2 deterministic check rules — pure TypeScript evaluation (F1-003).
 *
 * This module is the deterministic evidence-to-control layer the CEO research
 * direction demands "the LLM cannot override" and the concrete answer to
 * feasibility_analysis risk #1 (hallucinated control mapping). Every rule is a
 * pure function over the zod-validated snapshot JSON produced by the F1-002
 * connectors — NO model is ever in this path, and every verdict names the exact
 * JSON path inside the snapshot that fired so the finding is traceable to its
 * source (the answer to the Vanta complaint that checks "don't capture
 * everything accurately").
 *
 * Each evaluator takes the parsed `content` of a single snapshot (keyed by
 * resource_type in catalog.ts) and returns a {@link RuleEvaluation}. There is no
 * I/O here; the mapper (mapper.ts) is responsible for loading snapshots and
 * persisting the results.
 */

export type RuleVerdict = "pass" | "fail";

export interface RuleEvaluation {
  status: RuleVerdict;
  /** The exact JSON path inside the snapshot that the verdict is based on. */
  jsonPath: string;
  /** Human-readable "why this fired" sentence (never model-generated). */
  rationale: string;
  /** The raw JSON excerpt the UI renders in the "why this fired" expander. */
  excerpt: unknown;
}

/** An evaluator is a pure function from snapshot content → verdict. */
export type CheckEvaluator = (content: unknown) => RuleEvaluation;

// ── small helpers (defensive — snapshots are validated at ingestion but the
//    mapper may hand us a legacy / partial row, so we never throw) ────────────

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asBool(value: unknown): boolean {
  return value === true;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

// ── AWS IAM ──────────────────────────────────────────────────────────────────

/** Root account MFA — AWS IAM account summary `AccountMFAEnabled` must be 1. */
export function evalRootHardwareMfa(content: unknown): RuleEvaluation {
  const summary = asObject(asObject(content).accountSummary);
  const mfa = asNumber(summary.AccountMFAEnabled);
  const path = "iam.accountSummary.AccountMFAEnabled";
  if (mfa === null) {
    return {
      status: "fail",
      jsonPath: path,
      rationale:
        "The IAM account summary did not report AccountMFAEnabled, so root MFA could not be confirmed.",
      excerpt: { accountSummary: summary },
    };
  }
  if (mfa >= 1) {
    return {
      status: "pass",
      jsonPath: path,
      rationale: "The AWS account root user has multi-factor authentication enabled (AccountMFAEnabled = 1).",
      excerpt: { AccountMFAEnabled: mfa },
    };
  }
  return {
    status: "fail",
    jsonPath: path,
    rationale: "The AWS account root user does NOT have MFA enabled (AccountMFAEnabled = 0).",
    excerpt: { AccountMFAEnabled: mfa },
  };
}

/** Every IAM user must carry at least one MFA device. */
export function evalIamAllUsersMfa(content: unknown): RuleEvaluation {
  const users = asArray(asObject(content).users).map(asObject);
  const path = "iam.users[].mfaEnabled";
  const offenders = users
    .filter((u) => !asBool(u.mfaEnabled))
    .map((u) => ({ userName: String(u.userName ?? ""), mfaDeviceCount: asNumber(u.mfaDeviceCount) ?? 0 }));
  if (users.length === 0) {
    return {
      status: "pass",
      jsonPath: path,
      rationale: "No IAM users exist in the account, so there are no un-MFA'd console identities.",
      excerpt: { users: [] },
    };
  }
  if (offenders.length === 0) {
    return {
      status: "pass",
      jsonPath: path,
      rationale: `All ${users.length} IAM user(s) have at least one MFA device registered.`,
      excerpt: { userCount: users.length, usersWithoutMfa: [] },
    };
  }
  return {
    status: "fail",
    jsonPath: path,
    rationale: `${offenders.length} of ${users.length} IAM user(s) have no MFA device: ${offenders
      .map((o) => o.userName)
      .join(", ")}.`,
    excerpt: { usersWithoutMfa: offenders },
  };
}

/** Account password policy must require a minimum length of at least 14. */
export function evalIamPasswordPolicyStrong(content: unknown): RuleEvaluation {
  const policy = asObject(content).passwordPolicy;
  const path = "iam.passwordPolicy.MinimumPasswordLength";
  if (!policy || typeof policy !== "object") {
    return {
      status: "fail",
      jsonPath: "iam.passwordPolicy",
      rationale: "No account password policy is configured, so a strong-password standard is not enforced.",
      excerpt: { passwordPolicy: null },
    };
  }
  const min = asNumber(asObject(policy).MinimumPasswordLength);
  if (min !== null && min >= 14) {
    return {
      status: "pass",
      jsonPath: path,
      rationale: `The account password policy requires at least ${min} characters (standard is 14).`,
      excerpt: { MinimumPasswordLength: min },
    };
  }
  return {
    status: "fail",
    jsonPath: path,
    rationale: `The account password policy minimum length is ${min ?? "unset"}, below the required 14 characters.`,
    excerpt: { MinimumPasswordLength: min, passwordPolicy: policy },
  };
}

// ── AWS CloudTrail ─────────────────────────────────────────────────────────

/** At least one trail: multi-region + logging + log-file validation enabled. */
export function evalCloudTrailMultiRegionValidation(content: unknown): RuleEvaluation {
  const trails = asArray(asObject(content).trails).map(asObject);
  const path = "cloudtrail.trails[]";
  const match = trails.find(
    (t) => asBool(t.isMultiRegion) && asBool(t.isLogging) && asBool(t.logFileValidationEnabled),
  );
  if (match) {
    return {
      status: "pass",
      jsonPath: path,
      rationale: `Trail "${String(match.name ?? "")}" is multi-region, actively logging, and has log-file validation enabled.`,
      excerpt: {
        name: match.name,
        isMultiRegion: match.isMultiRegion,
        isLogging: match.isLogging,
        logFileValidationEnabled: match.logFileValidationEnabled,
      },
    };
  }
  return {
    status: "fail",
    jsonPath: path,
    rationale:
      trails.length === 0
        ? "No CloudTrail trails are configured, so there is no account-wide audit trail."
        : "No CloudTrail trail is simultaneously multi-region, logging, and log-file-validated.",
    excerpt: {
      trails: trails.map((t) => ({
        name: t.name,
        isMultiRegion: t.isMultiRegion,
        isLogging: t.isLogging,
        logFileValidationEnabled: t.logFileValidationEnabled,
      })),
    },
  };
}

// ── AWS Config ─────────────────────────────────────────────────────────────

/** At least one AWS Config recorder must be actively recording. */
export function evalConfigRecorderRecording(content: unknown): RuleEvaluation {
  const recorders = asArray(asObject(content).recorders).map(asObject);
  const path = "config.recorders[].recording";
  const active = recorders.find((r) => asBool(r.recording));
  if (active) {
    return {
      status: "pass",
      jsonPath: path,
      rationale: `AWS Config recorder "${String(active.name ?? "")}" is actively recording configuration changes.`,
      excerpt: { name: active.name, recording: active.recording, lastStatus: active.lastStatus },
    };
  }
  return {
    status: "fail",
    jsonPath: path,
    rationale:
      recorders.length === 0
        ? "No AWS Config recorder is configured, so configuration changes are not continuously monitored."
        : "No AWS Config recorder is currently recording configuration changes.",
    excerpt: {
      recorders: recorders.map((r) => ({
        name: r.name,
        recording: r.recording,
        lastStatus: r.lastStatus,
      })),
    },
  };
}

// ── AWS S3 ───────────────────────────────────────────────────────────────────

/** Every S3 bucket must have the full public-access-block configuration on. */
export function evalS3PublicAccessBlock(content: unknown): RuleEvaluation {
  const buckets = asArray(asObject(content).buckets).map(asObject);
  const path = "s3.buckets[].publicAccessBlockEnabled";
  const offenders = buckets
    .filter((b) => !asBool(b.publicAccessBlockEnabled))
    .map((b) => ({ name: String(b.name ?? ""), blockConfig: b.blockConfig ?? null }));
  if (buckets.length === 0) {
    return {
      status: "pass",
      jsonPath: path,
      rationale: "No S3 buckets exist in the account, so no bucket can expose data publicly.",
      excerpt: { buckets: [] },
    };
  }
  if (offenders.length === 0) {
    return {
      status: "pass",
      jsonPath: path,
      rationale: `All ${buckets.length} S3 bucket(s) have the full public-access-block configuration enabled.`,
      excerpt: { bucketCount: buckets.length, bucketsWithoutBlock: [] },
    };
  }
  return {
    status: "fail",
    jsonPath: path,
    rationale: `${offenders.length} of ${buckets.length} S3 bucket(s) do not fully block public access: ${offenders
      .map((o) => o.name)
      .join(", ")}.`,
    excerpt: { bucketsWithoutBlock: offenders },
  };
}

// ── AWS KMS ──────────────────────────────────────────────────────────────────

/** Every customer-managed KMS key must have automatic rotation enabled. */
export function evalKmsKeyRotationEnabled(content: unknown): RuleEvaluation {
  const keys = asArray(asObject(content).keys).map(asObject);
  const path = "kms.keys[].rotationEnabled";
  const offenders = keys.filter((k) => !asBool(k.rotationEnabled)).map((k) => String(k.keyId ?? ""));
  if (keys.length === 0) {
    return {
      status: "pass",
      jsonPath: path,
      rationale: "No customer-managed KMS keys were found, so there are no un-rotated keys.",
      excerpt: { keys: [] },
    };
  }
  if (offenders.length === 0) {
    return {
      status: "pass",
      jsonPath: path,
      rationale: `All ${keys.length} KMS key(s) have automatic rotation enabled.`,
      excerpt: { keyCount: keys.length, keysWithoutRotation: [] },
    };
  }
  return {
    status: "fail",
    jsonPath: path,
    rationale: `${offenders.length} of ${keys.length} KMS key(s) do not have rotation enabled.`,
    excerpt: { keysWithoutRotation: offenders },
  };
}

// ── GitHub ───────────────────────────────────────────────────────────────────

/** The GitHub organization must enforce two-factor authentication. */
export function evalGithubOrg2faEnforced(content: unknown): RuleEvaluation {
  const data = asObject(content);
  const path = "members.twoFactorRequirementEnabled";
  const enforced = data.twoFactorRequirementEnabled;
  if (enforced === true) {
    return {
      status: "pass",
      jsonPath: path,
      rationale: `The "${String(data.orgLogin ?? "")}" GitHub organization enforces two-factor authentication for all members.`,
      excerpt: { orgLogin: data.orgLogin, twoFactorRequirementEnabled: true },
    };
  }
  return {
    status: "fail",
    jsonPath: path,
    rationale:
      enforced === null || enforced === undefined
        ? "The GitHub organization's 2FA requirement could not be read (the app may lack org-admin read)."
        : "The GitHub organization does NOT enforce two-factor authentication.",
    excerpt: { orgLogin: data.orgLogin, twoFactorRequirementEnabled: enforced ?? null },
  };
}

/** Every repo default branch must be protected and require ≥1 approving review. */
export function evalBranchRequiresReview(content: unknown): RuleEvaluation {
  const repos = asArray(asObject(content).repos).map(asObject);
  const path = "branch_protection.repos[].requiredApprovingReviewCount";
  const offenders = repos
    .filter((r) => !asBool(r.protected) || (asNumber(r.requiredApprovingReviewCount) ?? 0) < 1)
    .map((r) => ({
      name: String(r.name ?? ""),
      protected: asBool(r.protected),
      requiredApprovingReviewCount: asNumber(r.requiredApprovingReviewCount),
    }));
  if (repos.length === 0) {
    return {
      status: "fail",
      jsonPath: path,
      rationale: "No repositories were found in scope, so required-review enforcement could not be evidenced.",
      excerpt: { repos: [] },
    };
  }
  if (offenders.length === 0) {
    return {
      status: "pass",
      jsonPath: path,
      rationale: `All ${repos.length} repositor(ies) protect the default branch and require at least one approving review.`,
      excerpt: { repoCount: repos.length, nonCompliantRepos: [] },
    };
  }
  return {
    status: "fail",
    jsonPath: path,
    rationale: `${offenders.length} of ${repos.length} repositor(ies) do not require a review on the default branch: ${offenders
      .map((o) => o.name)
      .join(", ")}.`,
    excerpt: { nonCompliantRepos: offenders },
  };
}

/** Default-branch protection must be enforced for administrators on every repo. */
export function evalBranchEnforceAdmins(content: unknown): RuleEvaluation {
  const repos = asArray(asObject(content).repos).map(asObject);
  const path = "branch_protection.repos[].enforceAdmins";
  const protectedRepos = repos.filter((r) => asBool(r.protected));
  const offenders = protectedRepos
    .filter((r) => !asBool(r.enforceAdmins))
    .map((r) => String(r.name ?? ""));
  if (repos.length === 0) {
    return {
      status: "fail",
      jsonPath: path,
      rationale: "No repositories were found in scope, so admin enforcement could not be evidenced.",
      excerpt: { repos: [] },
    };
  }
  if (protectedRepos.length === 0) {
    return {
      status: "fail",
      jsonPath: path,
      rationale: "No repository default branch is protected, so protection cannot be enforced for administrators.",
      excerpt: { repos: repos.map((r) => ({ name: r.name, protected: r.protected })) },
    };
  }
  if (offenders.length === 0) {
    return {
      status: "pass",
      jsonPath: path,
      rationale: `All ${protectedRepos.length} protected repositor(ies) enforce branch protection for administrators.`,
      excerpt: { protectedRepoCount: protectedRepos.length, reposWithoutAdminEnforcement: [] },
    };
  }
  return {
    status: "fail",
    jsonPath: path,
    rationale: `${offenders.length} of ${protectedRepos.length} protected repositor(ies) do not enforce protection for admins: ${offenders.join(
      ", ",
    )}.`,
    excerpt: { reposWithoutAdminEnforcement: offenders },
  };
}

/**
 * The deterministic rule registry: ruleKey → pure evaluator. The mapper looks a
 * rule up here by key; a rule with no registered evaluator is treated as
 * not_evaluated (never silently passed).
 */
export const CHECK_EVALUATORS: Record<string, CheckEvaluator> = {
  root_hardware_mfa: evalRootHardwareMfa,
  iam_all_users_mfa: evalIamAllUsersMfa,
  iam_password_policy_strong: evalIamPasswordPolicyStrong,
  cloudtrail_multiregion_validation: evalCloudTrailMultiRegionValidation,
  config_recorder_recording: evalConfigRecorderRecording,
  s3_public_access_block: evalS3PublicAccessBlock,
  kms_key_rotation_enabled: evalKmsKeyRotationEnabled,
  github_org_2fa_enforced: evalGithubOrg2faEnforced,
  branch_requires_review: evalBranchRequiresReview,
  branch_enforce_admins: evalBranchEnforceAdmins,
};

/** Evaluate a rule by key against a snapshot's content, or null if unknown. */
export function evaluateRule(ruleKey: string, content: unknown): RuleEvaluation | null {
  const evaluator = CHECK_EVALUATORS[ruleKey];
  if (!evaluator) return null;
  return evaluator(content);
}
