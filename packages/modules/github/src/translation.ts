export type GitHubTranslationErrorCode =
  | "github.unauthorized"
  | "github.rate-limited"
  | "github.branch-not-found"
  | "github.change-request-invalid"
  | "github.change-request-create-failed";

export interface GitHubTranslationFailure {
  readonly code: GitHubTranslationErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export class GitHubTranslationError extends Error {
  public constructor(
    public readonly code: GitHubTranslationErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GitHubTranslationError";
  }
}

export interface GitHubWorkItemReference {
  readonly ref: string;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}

export interface GitHubChangeRequestCreationRequestedPayload {
  readonly repositoryId: string;
  readonly workItemRef: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly headCommit: string;
  readonly title: string;
  readonly description: string;
  readonly draft?: boolean;
}

export interface GitHubPullRequestCreationBody {
  readonly title: string;
  readonly head: string;
  readonly base: string;
  readonly draft: boolean;
  readonly body: string;
}

export interface GitHubChangeRequestCreatedPayload {
  readonly repositoryId: string;
  readonly changeRequestRef: string;
  readonly externalNumber: number;
  readonly url: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly headCommit: string;
  readonly workItemRef: string;
  readonly draft?: boolean;
}

export type GitHubResponseHeaders =
  Readonly<Record<string, string | readonly string[] | undefined>> | Headers;

export interface GitHubPullRequestErrorResponse {
  readonly status: number;
  readonly headers?: GitHubResponseHeaders;
  readonly body?: unknown;
}

export function parseGitHubWorkItemRef(ref: string): GitHubWorkItemReference {
  const match =
    /^github:\/\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_-])?)\/issues\/([1-9]\d*)$/.exec(
      ref,
    );
  if (match === null) throw invalidReference();

  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) throw invalidReference();
  const owner = match[1];
  const repository = match[2];
  if (owner === undefined || repository === undefined) throw invalidReference();

  return { ref, owner, repository, number };
}

export function buildGitHubPullRequestBody(
  request: GitHubChangeRequestCreationRequestedPayload,
): GitHubPullRequestCreationBody {
  parseGitHubWorkItemRef(request.workItemRef);
  return {
    title: request.title,
    head: request.headBranch,
    base: request.baseBranch,
    draft: request.draft ?? false,
    body: `${request.description}\n\nImplements Work Item ${request.workItemRef}.`,
  };
}

export function translateGitHubPullRequestResponse(
  response: unknown,
  request: GitHubChangeRequestCreationRequestedPayload,
): GitHubChangeRequestCreatedPayload {
  parseGitHubWorkItemRef(request.workItemRef);
  const providerResponse = asProviderResponse(response);
  const status = providerResponse.status;
  if (status !== undefined && !isSuccessful(status)) {
    throw failureAsError(
      mapGitHubPullRequestError({
        status,
        body: providerResponse.body,
        ...(providerResponse.headers === undefined ? {} : { headers: providerResponse.headers }),
      }),
    );
  }

  const body = providerResponse.body;
  if (!isRecord(body)) throw creationFailed();

  const externalNumber = body["number"];
  if (
    typeof externalNumber !== "number" ||
    !Number.isSafeInteger(externalNumber) ||
    externalNumber < 1
  ) {
    throw creationFailed();
  }

  const url = usableUrl(body["html_url"]) ?? usableUrl(body["url"]);
  if (url === undefined) throw creationFailed();

  const parsedRef = parseGitHubWorkItemRef(request.workItemRef);
  const draft = typeof body["draft"] === "boolean" ? body["draft"] : (request.draft ?? false);
  return {
    repositoryId: request.repositoryId,
    changeRequestRef: `github://${parsedRef.owner}/${parsedRef.repository}/pulls/${externalNumber}`,
    externalNumber,
    url,
    baseBranch: request.baseBranch,
    headBranch: request.headBranch,
    headCommit: request.headCommit,
    workItemRef: request.workItemRef,
    draft,
  };
}

/** Rebuilds a created fact from the URL stored in an External Mapping. */
export function translateGitHubPullRequestMapping(
  resourceRef: string,
  request: GitHubChangeRequestCreationRequestedPayload,
): GitHubChangeRequestCreatedPayload {
  const parsedRequest = parseGitHubWorkItemRef(request.workItemRef);
  const url = usableUrl(resourceRef);
  if (url === undefined) throw creationFailed();

  const path = new URL(url).pathname.split("/").filter(Boolean);
  const offset = path[0] === "repos" ? 1 : 0;
  const owner = path[offset];
  const repository = path[offset + 1];
  const kind = path[offset + 2];
  const numberText = path[offset + 3];
  const externalNumber = Number(numberText);
  if (
    owner !== parsedRequest.owner ||
    repository !== parsedRequest.repository ||
    kind !== "pull" ||
    numberText === undefined ||
    !Number.isSafeInteger(externalNumber) ||
    externalNumber < 1 ||
    path.length !== offset + 4
  ) {
    throw creationFailed();
  }

  return {
    repositoryId: request.repositoryId,
    changeRequestRef: `github://${parsedRequest.owner}/${parsedRequest.repository}/pulls/${externalNumber}`,
    externalNumber,
    url,
    baseBranch: request.baseBranch,
    headBranch: request.headBranch,
    headCommit: request.headCommit,
    workItemRef: request.workItemRef,
    draft: request.draft ?? false,
  };
}

/** Translates an open-PR lookup, returning only a head/base match. */
export function translateGitHubPullRequestLookupResponse(
  response: unknown,
  request: GitHubChangeRequestCreationRequestedPayload,
): GitHubChangeRequestCreatedPayload | undefined {
  const providerResponse = asProviderResponse(response);
  if (providerResponse.status !== undefined && !isSuccessful(providerResponse.status)) {
    throw failureAsError(
      mapGitHubPullRequestError({
        status: providerResponse.status,
        body: providerResponse.body,
        ...(providerResponse.headers === undefined ? {} : { headers: providerResponse.headers }),
      }),
    );
  }
  if (!Array.isArray(providerResponse.body)) throw creationFailed();
  const match = providerResponse.body.find((candidate) => matchesPullRequest(candidate, request));
  return match === undefined
    ? undefined
    : translateGitHubPullRequestResponse({ status: 200, body: match }, request);
}

export function mapGitHubPullRequestError(
  response: GitHubPullRequestErrorResponse,
): GitHubTranslationFailure {
  const text = providerText(response.body);
  if (isRateLimited(response.status, response.headers, text)) {
    return failure(
      "github.rate-limited",
      "GitHub rate limit prevents this request; retry later.",
      true,
    );
  }
  if (response.status === 401 || response.status === 403) {
    return failure("github.unauthorized", "GitHub cannot access the requested repository.", false);
  }
  if (hasMissingHeadBranch(text)) {
    return failure(
      "github.branch-not-found",
      "GitHub cannot find the requested head branch.",
      false,
    );
  }
  if (isSemanticRejection(response.status, text)) {
    return failure(
      "github.change-request-invalid",
      "GitHub rejected the pull request input.",
      false,
    );
  }
  return failure(
    "github.change-request-create-failed",
    "GitHub pull request creation failed.",
    retryableStatus(response.status),
  );
}

function asProviderResponse(value: unknown): {
  readonly status: number | undefined;
  readonly body: unknown;
  readonly headers: GitHubResponseHeaders | undefined;
} {
  if (isRecord(value) && typeof value["status"] === "number" && Object.hasOwn(value, "body")) {
    return {
      status: value["status"],
      body: value["body"],
      headers: isHeaders(value["headers"]) ? value["headers"] : undefined,
    };
  }
  return { status: undefined, body: value, headers: undefined };
}

function isSuccessful(status: number): boolean {
  return status >= 200 && status < 300;
}

function usableUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname === "/"
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function isRateLimited(
  status: number,
  headers: GitHubResponseHeaders | undefined,
  text: string,
): boolean {
  if (
    status === 429 ||
    /\brate[- ]limit(?:ed|ing)?\b|secondary rate limit|abuse detection/i.test(text)
  ) {
    return true;
  }
  return (
    status === 403 &&
    (header(headers, "x-ratelimit-remaining") === "0" ||
      header(headers, "retry-after") !== undefined)
  );
}

function hasMissingHeadBranch(text: string): boolean {
  return (
    /head\s+(?:branch|ref)\b[^\n]*(?:not found|does not exist|missing)/i.test(text) ||
    /(?:branch|ref)\b[^\n]*(?:not found|does not exist|missing)/i.test(text)
  );
}

function isSemanticRejection(status: number, text: string): boolean {
  return (
    status === 422 ||
    (status === 400 && /invalid|validation|unprocessable|pull request/i.test(text))
  );
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status >= 500;
}

function providerText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function header(headers: GitHubResponseHeaders | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined;
  if (isHeaders(headers)) return headers.get(name) ?? undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];
  if (typeof value === "string") return value;
  return value?.[0];
}

function isHeaders(value: unknown): value is Headers {
  return typeof Headers !== "undefined" && value instanceof Headers;
}

function failure(
  code: GitHubTranslationErrorCode,
  message: string,
  retryable: boolean,
): GitHubTranslationFailure {
  return { code, message, retryable };
}

function failureAsError(value: GitHubTranslationFailure): GitHubTranslationError {
  return new GitHubTranslationError(value.code, value.message, value.retryable);
}

function invalidReference(): GitHubTranslationError {
  return new GitHubTranslationError(
    "github.change-request-invalid",
    "The Work Item reference is not a valid GitHub Issue reference.",
    false,
  );
}

function creationFailed(): GitHubTranslationError {
  return new GitHubTranslationError(
    "github.change-request-create-failed",
    "GitHub pull request creation returned an unusable response.",
    false,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesPullRequest(
  value: unknown,
  request: GitHubChangeRequestCreationRequestedPayload,
): boolean {
  if (!isRecord(value)) return false;
  const head = value["head"];
  const base = value["base"];
  return (
    isRecord(head) &&
    head["ref"] === request.headBranch &&
    isRecord(base) &&
    base["ref"] === request.baseBranch
  );
}
