import { GitHubCliCredentialResolver, type GitHubCredentialResolutionPort } from "./credentials.js";

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const GITHUB_CAPABILITIES = ["github.api", "scm.change-request.manage", "work-items.read"] as const;

export type GitHubProviderCheckStatus = "available" | "unauthenticated" | "unavailable" | "revoked";

export type GitHubProviderCheckResult =
  | {
      readonly status: "available";
      readonly accountLabel: string;
      readonly capabilities: readonly string[];
    }
  | { readonly status: Exclude<GitHubProviderCheckStatus, "available"> };

export interface GitHubProviderCheckPort {
  check(secretRef: string): Promise<GitHubProviderCheckResult>;
}

export interface GitHubProviderCheckOptions {
  readonly credentialResolver?: GitHubCredentialResolutionPort;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
}

/** Checks one GitHub credential with the read-only `/user` endpoint. */
export class GitHubProviderCheckAdapter implements GitHubProviderCheckPort {
  private readonly credentialResolver: GitHubCredentialResolutionPort;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;

  public constructor(options: GitHubProviderCheckOptions = {}) {
    this.credentialResolver = options.credentialResolver ?? new GitHubCliCredentialResolver();
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.timeoutMs = boundedTimeout(options.timeoutMs);
  }

  public async check(secretRef: string): Promise<GitHubProviderCheckResult> {
    let resolution: Awaited<ReturnType<GitHubCredentialResolutionPort["resolve"]>>;
    try {
      resolution = await this.credentialResolver.resolve(secretRef);
    } catch {
      return { status: "unavailable" };
    }

    if (resolution.status !== "available") return { status: resolution.status };

    let userUrl: URL;
    try {
      userUrl = new URL("user", `${this.apiBaseUrl.replace(/\/?$/, "/")}`);
    } catch {
      return { status: "unavailable" };
    }

    try {
      const response = await fetch(userUrl, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${resolution.credential}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const body = await response.text();
      const payload = parseJson(body);

      if (reportsRevoked(payload) || (!response.ok && /\brevoked\b/i.test(body))) {
        return { status: "revoked" };
      }
      if (response.status === 401) return { status: "unauthenticated" };
      if (!response.ok || !isRecord(payload) || typeof payload["login"] !== "string") {
        return { status: "unavailable" };
      }

      const accountLabel = payload["login"];
      return accountLabel.trim() === ""
        ? { status: "unavailable" }
        : {
            status: "available",
            accountLabel,
            capabilities: [...GITHUB_CAPABILITIES],
          };
    } catch {
      return { status: "unavailable" };
    }
  }
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function reportsRevoked(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value["revoked"] === true) return true;
  return ["message", "error", "error_description", "status"].some(
    (key) => typeof value[key] === "string" && /\brevoked\b/i.test(value[key]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
