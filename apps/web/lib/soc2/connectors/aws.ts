/**
 * AWS read-only connector (F1-002).
 *
 * Server-only. Connects a customer's AWS account via STS AssumeRole with a
 * per-org ExternalId — NO long-lived access keys are ever stored or requested.
 * The customer creates a cross-account IAM role trusting our principal + the
 * ExternalId, pastes the role ARN, and we assume it read-only to pull evidence:
 *   - IAM users / roles / policies / MFA status / password policy
 *   - CloudTrail trail configuration + logging status
 *   - AWS Config recorder status
 *   - S3 bucket public-access-block configuration
 *   - KMS key rotation status
 *
 * Every pull is validated with zod (schema volatility fails LOUD at ingestion,
 * not silently at scoring), then handed to snapshot.ts for redaction + hashing.
 */

import { z } from "zod";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import {
  IAMClient,
  ListUsersCommand,
  ListRolesCommand,
  ListPoliciesCommand,
  ListMFADevicesCommand,
  GetAccountPasswordPolicyCommand,
  GetAccountSummaryCommand,
} from "@aws-sdk/client-iam";
import {
  CloudTrailClient,
  DescribeTrailsCommand,
  GetTrailStatusCommand,
} from "@aws-sdk/client-cloudtrail";
import {
  ConfigServiceClient,
  DescribeConfigurationRecordersCommand,
  DescribeConfigurationRecorderStatusCommand,
} from "@aws-sdk/client-config-service";
import {
  S3Client,
  ListBucketsCommand,
  GetPublicAccessBlockCommand,
} from "@aws-sdk/client-s3";
import {
  KMSClient,
  ListKeysCommand,
  GetKeyRotationStatusCommand,
} from "@aws-sdk/client-kms";

export const AWS_REGION = process.env.AWS_REGION || "us-east-1";

/**
 * The EXACT read-only IAM policy we require, published verbatim on /connect/trust
 * so prospects can audit it before signup. Read + List + Describe + Get only —
 * never a mutating action.
 */
export const AWS_READONLY_POLICY: Record<string, unknown> = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "Soc2ReadOnlyEvidence",
      Effect: "Allow",
      Action: [
        "iam:GetAccountPasswordPolicy",
        "iam:GetAccountSummary",
        "iam:ListUsers",
        "iam:ListRoles",
        "iam:ListPolicies",
        "iam:ListMFADevices",
        "iam:GenerateCredentialReport",
        "iam:GetCredentialReport",
        "cloudtrail:DescribeTrails",
        "cloudtrail:GetTrailStatus",
        "config:DescribeConfigurationRecorders",
        "config:DescribeConfigurationRecorderStatus",
        "s3:ListAllMyBuckets",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetBucketPolicyStatus",
        "kms:ListKeys",
        "kms:GetKeyRotationStatus",
      ],
      Resource: "*",
    },
  ],
};

/** The principal (our AWS account) the customer's role must trust. */
export function trustedPrincipalArn(): string {
  return (
    process.env.SOC2_AWS_TRUST_PRINCIPAL ||
    "arn:aws:iam::000000000000:root"
  );
}

/**
 * Render the trust (assume-role) policy the customer pastes into their role,
 * locked to our principal AND the per-org ExternalId so no other tenant (or
 * attacker who guesses the ARN) can assume it.
 */
export function awsTrustPolicy(externalId: string): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: trustedPrincipalArn() },
        Action: "sts:AssumeRole",
        Condition: { StringEquals: { "sts:ExternalId": externalId } },
      },
    ],
  };
}

// ── zod snapshot contracts ──────────────────────────────────────────────────

const iamUserSchema = z.object({
  userName: z.string(),
  userId: z.string(),
  arn: z.string(),
  createDate: z.string().nullable(),
  mfaEnabled: z.boolean(),
  mfaDeviceCount: z.number(),
});

export const iamSnapshotSchema = z.object({
  users: z.array(iamUserSchema),
  roles: z.array(z.object({ roleName: z.string(), arn: z.string() })),
  policies: z.array(z.object({ policyName: z.string(), arn: z.string() })),
  passwordPolicy: z.record(z.unknown()).nullable(),
  accountSummary: z.record(z.number()).nullable(),
});

export const cloudTrailSnapshotSchema = z.object({
  trails: z.array(
    z.object({
      name: z.string(),
      isMultiRegion: z.boolean(),
      isLogging: z.boolean(),
      includeGlobalServiceEvents: z.boolean(),
      logFileValidationEnabled: z.boolean(),
    }),
  ),
});

export const configSnapshotSchema = z.object({
  recorders: z.array(
    z.object({ name: z.string(), recording: z.boolean(), lastStatus: z.string().nullable() }),
  ),
});

export const s3SnapshotSchema = z.object({
  buckets: z.array(
    z.object({
      name: z.string(),
      publicAccessBlockEnabled: z.boolean(),
      blockConfig: z.record(z.boolean()).nullable(),
    }),
  ),
});

export const kmsSnapshotSchema = z.object({
  keys: z.array(z.object({ keyId: z.string(), rotationEnabled: z.boolean() })),
});

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/**
 * Assume the customer's cross-account role with the per-org ExternalId and
 * return temporary read-only credentials. Throws a clean error the UI can show
 * if the role / trust / ExternalId is misconfigured.
 */
export async function assumeRole(
  roleArn: string,
  externalId: string,
): Promise<AwsCredentials> {
  const sts = new STSClient({ region: AWS_REGION });
  const out = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: "nexus-soc2-readonly",
      ExternalId: externalId,
      DurationSeconds: 900,
    }),
  );
  const c = out.Credentials;
  if (!c || !c.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
    throw new Error("AssumeRole returned no credentials");
  }
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
  };
}

/**
 * Verify a role ARN is assumable with the ExternalId and return the resolved
 * AWS account id. Called by the /connect/aws verify step.
 */
export async function verifyAwsRole(
  roleArn: string,
  externalId: string,
): Promise<{ ok: boolean; accountId: string | null; error?: string }> {
  try {
    await assumeRole(roleArn, externalId);
    // RoleArn format: arn:aws:iam::<accountId>:role/<name>
    const match = roleArn.match(/arn:aws:iam::(\d+):role\//);
    return { ok: true, accountId: match ? match[1] : null };
  } catch (e) {
    return { ok: false, accountId: null, error: (e as Error).message };
  }
}

function credsConfig(creds: AwsCredentials): Record<string, unknown> {
  return {
    region: AWS_REGION,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  };
}

// ── collectors ──────────────────────────────────────────────────────────────

export async function collectIam(creds: AwsCredentials): Promise<z.infer<typeof iamSnapshotSchema>> {
  const iam = new IAMClient(credsConfig(creds));
  const usersOut = await iam.send(new ListUsersCommand({ MaxItems: 200 }));
  const users: z.infer<typeof iamUserSchema>[] = [];
  for (const u of usersOut.Users ?? []) {
    let mfaCount = 0;
    try {
      const mfa = await iam.send(new ListMFADevicesCommand({ UserName: u.UserName }));
      mfaCount = (mfa.MFADevices ?? []).length;
    } catch {
      mfaCount = 0;
    }
    users.push({
      userName: u.UserName ?? "",
      userId: u.UserId ?? "",
      arn: u.Arn ?? "",
      createDate: u.CreateDate ? new Date(u.CreateDate).toISOString() : null,
      mfaEnabled: mfaCount > 0,
      mfaDeviceCount: mfaCount,
    });
  }

  const rolesOut = await iam.send(new ListRolesCommand({ MaxItems: 200 }));
  const roles = (rolesOut.Roles ?? []).map((r) => ({
    roleName: r.RoleName ?? "",
    arn: r.Arn ?? "",
  }));

  const policiesOut = await iam.send(
    new ListPoliciesCommand({ Scope: "Local", MaxItems: 200 }),
  );
  const policies = (policiesOut.Policies ?? []).map((p) => ({
    policyName: p.PolicyName ?? "",
    arn: p.Arn ?? "",
  }));

  let passwordPolicy: Record<string, unknown> | null = null;
  try {
    const pp = await iam.send(new GetAccountPasswordPolicyCommand({}));
    passwordPolicy = (pp.PasswordPolicy ?? null) as Record<string, unknown> | null;
  } catch {
    passwordPolicy = null;
  }

  let accountSummary: Record<string, number> | null = null;
  try {
    const sum = await iam.send(new GetAccountSummaryCommand({}));
    accountSummary = (sum.SummaryMap ?? null) as Record<string, number> | null;
  } catch {
    accountSummary = null;
  }

  return iamSnapshotSchema.parse({ users, roles, policies, passwordPolicy, accountSummary });
}

export async function collectCloudTrail(
  creds: AwsCredentials,
): Promise<z.infer<typeof cloudTrailSnapshotSchema>> {
  const ct = new CloudTrailClient(credsConfig(creds));
  const out = await ct.send(new DescribeTrailsCommand({ includeShadowTrails: false }));
  const trails: z.infer<typeof cloudTrailSnapshotSchema>["trails"] = [];
  for (const t of out.trailList ?? []) {
    let isLogging = false;
    try {
      const status = await ct.send(new GetTrailStatusCommand({ Name: t.TrailARN ?? t.Name }));
      isLogging = Boolean(status.IsLogging);
    } catch {
      isLogging = false;
    }
    trails.push({
      name: t.Name ?? "",
      isMultiRegion: Boolean(t.IsMultiRegionTrail),
      isLogging,
      includeGlobalServiceEvents: Boolean(t.IncludeGlobalServiceEvents),
      logFileValidationEnabled: Boolean(t.LogFileValidationEnabled),
    });
  }
  return cloudTrailSnapshotSchema.parse({ trails });
}

export async function collectConfig(
  creds: AwsCredentials,
): Promise<z.infer<typeof configSnapshotSchema>> {
  const cfg = new ConfigServiceClient(credsConfig(creds));
  const recordersOut = await cfg.send(new DescribeConfigurationRecordersCommand({}));
  let statuses: Record<string, { recording: boolean; lastStatus: string | null }> = {};
  try {
    const statusOut = await cfg.send(new DescribeConfigurationRecorderStatusCommand({}));
    statuses = Object.fromEntries(
      (statusOut.ConfigurationRecordersStatus ?? []).map((s) => [
        s.name ?? "",
        { recording: Boolean(s.recording), lastStatus: s.lastStatus ?? null },
      ]),
    );
  } catch {
    statuses = {};
  }
  const recorders = (recordersOut.ConfigurationRecorders ?? []).map((r) => {
    const st = statuses[r.name ?? ""];
    return {
      name: r.name ?? "",
      recording: st ? st.recording : false,
      lastStatus: st ? st.lastStatus : null,
    };
  });
  return configSnapshotSchema.parse({ recorders });
}

export async function collectS3(creds: AwsCredentials): Promise<z.infer<typeof s3SnapshotSchema>> {
  const s3 = new S3Client(credsConfig(creds));
  const listed = await s3.send(new ListBucketsCommand({}));
  const buckets: z.infer<typeof s3SnapshotSchema>["buckets"] = [];
  for (const b of (listed.Buckets ?? []).slice(0, 200)) {
    const name = b.Name ?? "";
    if (!name) continue;
    let blockConfig: Record<string, boolean> | null = null;
    let enabled = false;
    try {
      const pab = await s3.send(new GetPublicAccessBlockCommand({ Bucket: name }));
      const c = pab.PublicAccessBlockConfiguration;
      if (c) {
        blockConfig = {
          blockPublicAcls: Boolean(c.BlockPublicAcls),
          ignorePublicAcls: Boolean(c.IgnorePublicAcls),
          blockPublicPolicy: Boolean(c.BlockPublicPolicy),
          restrictPublicBuckets: Boolean(c.RestrictPublicBuckets),
        };
        enabled = Object.values(blockConfig).every(Boolean);
      }
    } catch {
      // No public-access-block config on the bucket → treated as not enabled.
      blockConfig = null;
      enabled = false;
    }
    buckets.push({ name, publicAccessBlockEnabled: enabled, blockConfig });
  }
  return s3SnapshotSchema.parse({ buckets });
}

export async function collectKms(creds: AwsCredentials): Promise<z.infer<typeof kmsSnapshotSchema>> {
  const kms = new KMSClient(credsConfig(creds));
  const listed = await kms.send(new ListKeysCommand({ Limit: 200 }));
  const keys: z.infer<typeof kmsSnapshotSchema>["keys"] = [];
  for (const k of listed.Keys ?? []) {
    const keyId = k.KeyId ?? "";
    if (!keyId) continue;
    let rotationEnabled = false;
    try {
      const rot = await kms.send(new GetKeyRotationStatusCommand({ KeyId: keyId }));
      rotationEnabled = Boolean(rot.KeyRotationEnabled);
    } catch {
      // AWS-managed keys / asymmetric keys don't support rotation status.
      rotationEnabled = false;
    }
    keys.push({ keyId, rotationEnabled });
  }
  return kmsSnapshotSchema.parse({ keys });
}

/**
 * Run a single ingestion chunk for AWS: assume the role, pull the chunk's
 * resources, and return the validated content for persistence. Each chunk is a
 * separate ingestion job so no one Vercel function has to pull everything.
 */
export async function collectAwsChunk(
  chunkKey: string,
  roleArn: string,
  externalId: string,
): Promise<{ resourceType: string; content: unknown; resourceCount: number }> {
  const creds = await assumeRole(roleArn, externalId);
  switch (chunkKey) {
    case "iam": {
      const content = await collectIam(creds);
      return { resourceType: "iam", content, resourceCount: content.users.length };
    }
    case "cloudtrail": {
      const content = await collectCloudTrail(creds);
      return { resourceType: "cloudtrail", content, resourceCount: content.trails.length };
    }
    case "config": {
      const content = await collectConfig(creds);
      return { resourceType: "config", content, resourceCount: content.recorders.length };
    }
    case "s3": {
      const content = await collectS3(creds);
      return { resourceType: "s3", content, resourceCount: content.buckets.length };
    }
    case "kms": {
      const content = await collectKms(creds);
      return { resourceType: "kms", content, resourceCount: content.keys.length };
    }
    default:
      throw new Error(`unknown aws chunk: ${chunkKey}`);
  }
}
