/**
 * GitHub read-only connector (F1-002).
 *
 * Server-only. Connects a customer's GitHub organization via a GitHub App
 * INSTALLATION (not a user OAuth token) with read-only metadata / members /
 * administration / pull-request scopes. We authenticate as the App, mint a
 * short-lived installation token per pull, and collect:
 *   - org members + org-level 2FA enforcement
 *   - branch protection + required-review settings on default branches
 *   - recent pull-request history (merge + review activity)
 *
 * Every pull is validated with zod before it is handed to snapshot.ts for
 * redaction + hashing.
 */

import { z } from "zod";
import { App } from "octokit";

/**
 * The EXACT read-only GitHub App permissions we request, published on
 * /connect/trust so prospects can audit them before installing. All read-only.
 */
export const GITHUB_READONLY_SCOPES: ReadonlyArray<{ scope: string; access: string; why: string }> = [
  { scope: "metadata", access: "read", why: "Enumerate repositories in scope for evidence." },
  { scope: "members", access: "read", why: "List org members and read 2FA enforcement status." },
  { scope: "administration", access: "read", why: "Read branch protection + required-review rules." },
  { scope: "pull_requests", access: "read", why: "Read PR + review history for change-management evidence." },
];

export function githubAppSlug(): string {
  return process.env.GITHUB_APP_SLUG || "nexus-soc2";
}

/** URL a customer visits to install the GitHub App on their org. */
export function githubInstallUrl(state: string): string {
  const base = `https://github.com/apps/${encodeURIComponent(githubAppSlug())}/installations/new`;
  return `${base}?state=${encodeURIComponent(state)}`;
}

// ── zod snapshot contracts ──────────────────────────────────────────────────

export const membersSnapshotSchema = z.object({
  orgLogin: z.string(),
  twoFactorRequirementEnabled: z.boolean().nullable(),
  members: z.array(z.object({ login: z.string(), id: z.number() })),
});

export const branchProtectionSnapshotSchema = z.object({
  repos: z.array(
    z.object({
      name: z.string(),
      defaultBranch: z.string(),
      protected: z.boolean(),
      requiredApprovingReviewCount: z.number().nullable(),
      requireCodeOwnerReviews: z.boolean(),
      enforceAdmins: z.boolean(),
    }),
  ),
});

export const pullRequestsSnapshotSchema = z.object({
  repos: z.array(
    z.object({
      name: z.string(),
      recentPullRequests: z.array(
        z.object({
          number: z.number(),
          state: z.string(),
          merged: z.boolean(),
          reviewCount: z.number(),
        }),
      ),
    }),
  ),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InstallationOctokit = any;

function readPrivateKey(): string {
  const raw = process.env.GITHUB_APP_PRIVATE_KEY || "";
  // Env stores newlines escaped — restore them for the PEM parser.
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

/** Build the App client from env credentials. Throws if unconfigured. */
export function buildApp(): App {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = readPrivateKey();
  if (!appId || !privateKey) {
    throw new Error("GitHub App credentials not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)");
  }
  return new App({ appId, privateKey });
}

/** Mint an installation-scoped Octokit client. */
export async function installationClient(installationId: string): Promise<InstallationOctokit> {
  const app = buildApp();
  return app.getInstallationOctokit(Number(installationId));
}

/**
 * Resolve the org login + account type for an installation id (used on the
 * install callback + by the webhook to label the connector).
 */
export async function resolveInstallationOrg(
  installationId: string,
): Promise<{ login: string | null; accountType: string | null }> {
  try {
    const app = buildApp();
    const res = await app.octokit.request("GET /app/installations/{installation_id}", {
      installation_id: Number(installationId),
    });
    const account = (res.data as { account?: { login?: string; type?: string } }).account;
    return { login: account?.login ?? null, accountType: account?.type ?? null };
  } catch {
    return { login: null, accountType: null };
  }
}

async function listInstallationRepos(
  octokit: InstallationOctokit,
  limit: number,
): Promise<Array<{ name: string; owner: string; defaultBranch: string }>> {
  const res = await octokit.request("GET /installation/repositories", { per_page: Math.min(limit, 100) });
  const repos = (res.data?.repositories ?? []) as Array<{
    name: string;
    owner: { login: string };
    default_branch: string;
  }>;
  return repos.slice(0, limit).map((r) => ({
    name: r.name,
    owner: r.owner.login,
    defaultBranch: r.default_branch,
  }));
}

// ── collectors ──────────────────────────────────────────────────────────────

export async function collectMembers(
  octokit: InstallationOctokit,
  orgLogin: string,
): Promise<z.infer<typeof membersSnapshotSchema>> {
  let twoFactor: boolean | null = null;
  try {
    const org = await octokit.request("GET /orgs/{org}", { org: orgLogin });
    const data = org.data as { two_factor_requirement_enabled?: boolean | null };
    twoFactor = data.two_factor_requirement_enabled ?? null;
  } catch {
    twoFactor = null;
  }

  const members: Array<{ login: string; id: number }> = [];
  try {
    const res = await octokit.request("GET /orgs/{org}/members", {
      org: orgLogin,
      per_page: 100,
    });
    for (const m of (res.data ?? []) as Array<{ login: string; id: number }>) {
      members.push({ login: m.login, id: m.id });
    }
  } catch {
    /* no member read access → empty list */
  }

  return membersSnapshotSchema.parse({
    orgLogin,
    twoFactorRequirementEnabled: twoFactor,
    members,
  });
}

export async function collectBranchProtection(
  octokit: InstallationOctokit,
  orgLogin: string,
): Promise<z.infer<typeof branchProtectionSnapshotSchema>> {
  const repos = await listInstallationRepos(octokit, 50);
  const out: z.infer<typeof branchProtectionSnapshotSchema>["repos"] = [];
  for (const repo of repos) {
    let isProtected = false;
    let requiredApprovingReviewCount: number | null = null;
    let requireCodeOwnerReviews = false;
    let enforceAdmins = false;
    try {
      const prot = await octokit.request(
        "GET /repos/{owner}/{repo}/branches/{branch}/protection",
        { owner: repo.owner, repo: repo.name, branch: repo.defaultBranch },
      );
      const data = prot.data as {
        enforce_admins?: { enabled?: boolean };
        required_pull_request_reviews?: {
          required_approving_review_count?: number;
          require_code_owner_reviews?: boolean;
        };
      };
      isProtected = true;
      enforceAdmins = Boolean(data.enforce_admins?.enabled);
      if (data.required_pull_request_reviews) {
        requiredApprovingReviewCount =
          data.required_pull_request_reviews.required_approving_review_count ?? 0;
        requireCodeOwnerReviews = Boolean(
          data.required_pull_request_reviews.require_code_owner_reviews,
        );
      }
    } catch {
      // 404 → branch is not protected.
      isProtected = false;
    }
    out.push({
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      protected: isProtected,
      requiredApprovingReviewCount,
      requireCodeOwnerReviews,
      enforceAdmins,
    });
  }
  return branchProtectionSnapshotSchema.parse({ repos: out });
}

export async function collectPullRequests(
  octokit: InstallationOctokit,
): Promise<z.infer<typeof pullRequestsSnapshotSchema>> {
  const repos = await listInstallationRepos(octokit, 30);
  const out: z.infer<typeof pullRequestsSnapshotSchema>["repos"] = [];
  for (const repo of repos) {
    const recent: Array<{ number: number; state: string; merged: boolean; reviewCount: number }> = [];
    try {
      const prs = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
        owner: repo.owner,
        repo: repo.name,
        state: "closed",
        per_page: 20,
        sort: "updated",
        direction: "desc",
      });
      for (const pr of (prs.data ?? []) as Array<{
        number: number;
        state: string;
        merged_at: string | null;
      }>) {
        let reviewCount = 0;
        try {
          const reviews = await octokit.request(
            "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
            { owner: repo.owner, repo: repo.name, pull_number: pr.number, per_page: 100 },
          );
          reviewCount = ((reviews.data ?? []) as unknown[]).length;
        } catch {
          reviewCount = 0;
        }
        recent.push({
          number: pr.number,
          state: pr.state,
          merged: Boolean(pr.merged_at),
          reviewCount,
        });
      }
    } catch {
      /* no PR read access → empty */
    }
    out.push({ name: repo.name, recentPullRequests: recent });
  }
  return pullRequestsSnapshotSchema.parse({ repos: out });
}

/**
 * Run a single ingestion chunk for GitHub: mint an installation client, pull
 * the chunk's resources and return validated content for persistence.
 */
export async function collectGithubChunk(
  chunkKey: string,
  installationId: string,
  orgLogin: string | null,
): Promise<{ resourceType: string; content: unknown; resourceCount: number }> {
  const octokit = await installationClient(installationId);
  const login = orgLogin || (await resolveInstallationOrg(installationId)).login || "";
  switch (chunkKey) {
    case "members": {
      const content = await collectMembers(octokit, login);
      return { resourceType: "members", content, resourceCount: content.members.length };
    }
    case "branch_protection": {
      const content = await collectBranchProtection(octokit, login);
      return { resourceType: "branch_protection", content, resourceCount: content.repos.length };
    }
    case "pull_requests": {
      const content = await collectPullRequests(octokit);
      return { resourceType: "pull_requests", content, resourceCount: content.repos.length };
    }
    default:
      throw new Error(`unknown github chunk: ${chunkKey}`);
  }
}
