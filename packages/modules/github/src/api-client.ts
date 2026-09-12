import type {
  GitHubApi,
  GitHubApiRequest,
  GitHubApiResponse,
} from "../../../module-sdk/src/index.js";
import type { GitHubCredentialResolutionPort } from "./credentials.js";

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;

export type GitHubApiFailure = "unauthenticated" | "unavailable" | "revoked";

export class GitHubApiError extends Error {
  public constructor(public readonly status: GitHubApiFailure) {
    super(`GitHub API credential is ${status}.`);
    this.name = "GitHubApiError";
  }
}

export interface GitHubApiClientOptions {
  readonly secretRef: string;
  readonly credentialResolver: GitHubCredentialResolutionPort;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
}

/** A project-bound client that never retains the resolved credential. */
export class GitHubApiClient implements GitHubApi {
  private readonly secretRef: string;
  private readonly credentialResolver: GitHubCredentialResolutionPort;
  private readonly apiBaseUrl: URL;
  private readonly timeoutMs: number;

  public constructor(options: GitHubApiClientOptions) {
    this.secretRef = options.secretRef;
    this.credentialResolver = options.credentialResolver;
    this.apiBaseUrl = new URL(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.timeoutMs = boundedTimeout(options.timeoutMs);
  }

  public async get(path: string): Promise<GitHubApiResponse> {
    return this.request({ method: "GET", path });
  }

  public async request(input: GitHubApiRequest): Promise<GitHubApiResponse> {
    let resolution: Awaited<ReturnType<GitHubCredentialResolutionPort["resolve"]>>;
    try {
      resolution = await this.credentialResolver.resolve(this.secretRef);
    } catch {
      throw new GitHubApiError("unavailable");
    }
    if (resolution.status !== "available") throw new GitHubApiError(resolution.status);

    const url = apiUrl(this.apiBaseUrl, input.path);
    let response: Response;
    try {
      response = await fetch(url, {
        method: input.method ?? "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${resolution.credential}`,
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new GitHubApiError("unavailable");
    }
    const body = parseResponse(await response.text());
    const headers = readRateLimitHeaders(response.headers);
    return {
      status: response.status,
      body,
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    };
  }
}

function readRateLimitHeaders(headers: Headers): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const name of ["link", "retry-after", "x-ratelimit-remaining"] as const) {
    const value = headers.get(name);
    if (value !== null) selected[name] = value;
  }
  return selected;
}

function apiUrl(base: URL, path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("GitHub API paths must be absolute paths on the configured API host.");
  }
  return new URL(path.slice(1), ensureTrailingSlash(base));
}

function ensureTrailingSlash(base: URL): URL {
  const value = new URL(base.href);
  if (!value.pathname.endsWith("/")) value.pathname += "/";
  return value;
}

function parseResponse(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}
