import type { ModuleHandler, ModuleHandlerContext } from "../../../module-sdk/src/index.js";
import { GitHubApiError } from "./api-client.js";
import {
  buildGitHubPullRequestBody,
  GitHubTranslationError,
  parseGitHubWorkItemRef,
  translateGitHubPullRequestMapping,
  translateGitHubPullRequestLookupResponse,
  translateGitHubPullRequestResponse,
  mapGitHubWorkItemTagsError,
  translateGitHubWorkItemLabelsResponse,
  translateGitHubWorkItemResponse,
  type GitHubChangeRequestCreationRequestedPayload,
  type GitHubWorkItemTagsChangeRequestedPayload,
  type GitHubWorkItemTagsChangedPayload,
  type GitHubTranslationErrorCode,
} from "./translation.js";

export const GITHUB_CHANGE_REQUEST_CREATION_REQUESTED = {
  type: "scm.change-request.creation-requested",
  version: 1,
  kind: "request",
} as const;

export const GITHUB_CHANGE_REQUEST_CREATED = {
  type: "scm.change-request.created",
  version: 1,
  kind: "fact",
} as const;

export const GITHUB_CHANGE_REQUEST_CREATION_FAILED = {
  type: "scm.change-request.creation-failed",
  version: 1,
  kind: "fact",
} as const;

export const GITHUB_WORK_ITEM_TAGS_CHANGE_REQUESTED = {
  type: "scm.work-item.tags-change-requested",
  version: 1,
  kind: "request",
} as const;

export const GITHUB_WORK_ITEM_TAGS_CHANGED = {
  type: "scm.work-item.tags-changed",
  version: 1,
  kind: "fact",
} as const;

export const GITHUB_WORK_ITEM_TAGS_CHANGE_FAILED = {
  type: "scm.work-item.tags-change-failed",
  version: 1,
  kind: "fact",
} as const;

/** Handles one explicitly targeted Change Request creation request. */
export const handleChangeRequestCreationRequested: ModuleHandler = async (
  ctx: ModuleHandlerContext,
) => {
  const request = readCreationRequest(ctx.event.payload);
  const reference = parseGitHubWorkItemRef(request.workItemRef);
  if (ctx.repositoryId !== request.repositoryId) {
    throw invalidRequest("The request repository does not match its Event repository.");
  }
  const repository = ctx.repository;
  if (
    repository === undefined ||
    repository.provider !== "github" ||
    repository.owner.toLowerCase() !== reference.owner.toLowerCase() ||
    repository.name.toLowerCase() !== reference.repository.toLowerCase()
  ) {
    throw invalidRequest("The Work Item repository is not linked to the Project repository.");
  }
  const githubRepositoryId = `${repository.owner}/${repository.name}`;
  const idempotencyKey = ctx.event.idempotencyKey;
  if (idempotencyKey === undefined || idempotencyKey.length === 0) {
    throw invalidRequest("The request idempotency key is required.");
  }

  const externalMappings = ctx.capabilities.externalMappings;
  if (externalMappings === undefined) {
    throw new GitHubTranslationError(
      "github.change-request-create-failed",
      "The external mapping capability is unavailable.",
      true,
    );
  }
  try {
    const existing = externalMappings.read(idempotencyKey);
    if (existing?.status === "completed" && existing.resourceRef !== undefined) {
      const created = translateGitHubPullRequestMapping(existing.resourceRef, request);
      publishCreated(ctx, created);
      return created;
    }

    const githubApi = ctx.capabilities.githubApi;
    if (githubApi === undefined) {
      throw new GitHubTranslationError(
        "github.change-request-create-failed",
        "The GitHub API capability is unavailable.",
        true,
      );
    }
    externalMappings.recordAttempt(idempotencyKey);

    if (existing?.status === "attempted") {
      let lookup: Awaited<ReturnType<typeof githubApi.get>>;
      try {
        lookup = await githubApi.get(
          `/repos/${githubRepositoryId}/pulls?head=${encodeURIComponent(request.headBranch)}&state=open`,
        );
      } catch (error) {
        if (error instanceof GitHubTranslationError) throw error;
        throw new GitHubTranslationError(
          "github.change-request-create-failed",
          "GitHub pull request lookup failed; retry later.",
          true,
        );
      }
      const adopted = translateGitHubPullRequestLookupResponse(lookup, request);
      if (adopted !== undefined) {
        externalMappings.recordResource({
          idempotencyKey,
          resourceRef: adopted.url,
        });
        publishCreated(ctx, adopted);
        return adopted;
      }
    }

    const response = await githubApi.request({
      method: "POST",
      path: `/repos/${githubRepositoryId}/pulls`,
      body: { ...buildGitHubPullRequestBody(request) },
    });
    const created = translateGitHubPullRequestResponse(response, request);
    externalMappings.recordResource({
      idempotencyKey,
      resourceRef: created.url,
    });
    publishCreated(ctx, created);
    return created;
  } catch (error) {
    const failure = readFailure(error);
    ctx.publishFailure({
      ...GITHUB_CHANGE_REQUEST_CREATION_FAILED,
      subject: { type: "work-item", ref: request.workItemRef },
      repositoryId: request.repositoryId,
      payload: {
        repositoryId: request.repositoryId,
        workItemRef: request.workItemRef,
        code: failure.code,
        message: `GitHub could not create a Change Request for repository ${request.repositoryId} and Work Item ${request.workItemRef}: ${failure.message}`,
        retryable: failure.retryable,
      },
    });
    throw failure.error;
  }
};

/** Handles one explicitly targeted, additive Work Item label mutation. */
export const handleWorkItemTagsChangeRequested: ModuleHandler = async (
  ctx: ModuleHandlerContext,
) => {
  const request = readTagsChangeRequest(ctx.event.payload);
  const reference = parseGitHubWorkItemRef(request.workItemRef);
  if (ctx.repositoryId !== request.repositoryId) {
    throw invalidTagsChangeRequest("The request repository does not match its Event repository.");
  }
  const repository = ctx.repository;
  if (
    repository === undefined ||
    repository.provider !== "github" ||
    repository.owner.toLowerCase() !== reference.owner.toLowerCase() ||
    repository.name.toLowerCase() !== reference.repository.toLowerCase()
  ) {
    throw invalidTagsChangeRequest(
      "The Work Item repository is not linked to the Project repository.",
    );
  }
  const idempotencyKey = ctx.event.idempotencyKey;
  if (idempotencyKey === undefined || idempotencyKey.length === 0) {
    throw invalidTagsChangeRequest("The request idempotency key is required.");
  }

  const externalMappings = ctx.capabilities.externalMappings;
  const githubApi = ctx.capabilities.githubApi;
  if (externalMappings === undefined || githubApi === undefined) {
    throw new GitHubTranslationError(
      "github.work-item-tags-failed",
      "The GitHub label mutation capability is unavailable.",
      true,
    );
  }

  try {
    const existing = externalMappings.read(idempotencyKey);
    if (existing?.status === "completed") {
      const receipt = decodeTagsChangeReceipt(existing.resourceRef);
      if (receipt === undefined || !sameTagsChangeRequest(receipt, request)) {
        throw invalidTagsChangeRequest(
          "The idempotency key was already used for another label change.",
        );
      }
      const changed: GitHubWorkItemTagsChangedPayload = {
        ...request,
        observedTags: receipt.observedTags,
      };
      publishTagsChanged(ctx, changed);
      return changed;
    }

    externalMappings.recordAttempt(idempotencyKey);
    let observedTags = await readGitHubWorkItemLabels(githubApi, reference, request.workItemRef);
    const missingTags = request.addTags.filter((tag) => !observedTags.includes(tag));
    if (missingTags.length !== 0) {
      await requestGitHubLabels(githubApi, reference, request.workItemRef, missingTags);
      observedTags = await readGitHubWorkItemLabels(githubApi, reference, request.workItemRef);
      if (missingTags.some((tag) => !observedTags.includes(tag))) {
        throw transientTagsChangeFailure("GitHub did not confirm the requested labels.");
      }
    }

    for (const tag of request.removeTags) {
      if (!observedTags.includes(tag)) continue;
      await removeGitHubLabel(githubApi, reference, request.workItemRef, tag);
      observedTags = await readGitHubWorkItemLabels(githubApi, reference, request.workItemRef);
      if (observedTags.includes(tag)) {
        throw transientTagsChangeFailure("GitHub did not confirm the label removal.");
      }
    }

    observedTags = await readGitHubWorkItemLabels(githubApi, reference, request.workItemRef);
    if (
      request.addTags.some((tag) => !observedTags.includes(tag)) ||
      request.removeTags.some((tag) => observedTags.includes(tag))
    ) {
      throw transientTagsChangeFailure("GitHub did not confirm the requested label state.");
    }

    const changed: GitHubWorkItemTagsChangedPayload = { ...request, observedTags };
    externalMappings.recordResource({
      idempotencyKey,
      resourceRef: encodeTagsChangeReceipt(request, observedTags),
    });
    publishTagsChanged(ctx, changed);
    return changed;
  } catch (error) {
    const failure = readFailure(error);
    ctx.publishFailure({
      ...GITHUB_WORK_ITEM_TAGS_CHANGE_FAILED,
      subject: { type: "work-item", ref: request.workItemRef },
      repositoryId: request.repositoryId,
      payload: {
        ...request,
        errorCode: failure.code,
        retryable: failure.retryable,
      },
    });
    throw failure.error;
  }
};

function publishTagsChanged(
  ctx: ModuleHandlerContext,
  changed: GitHubWorkItemTagsChangedPayload,
): void {
  ctx.publish({
    ...GITHUB_WORK_ITEM_TAGS_CHANGED,
    subject: { type: "work-item", ref: changed.workItemRef },
    repositoryId: changed.repositoryId,
    payload: { ...changed },
  });
}

async function readGitHubWorkItemLabels(
  api: NonNullable<ModuleHandlerContext["capabilities"]["githubApi"]>,
  reference: ReturnType<typeof parseGitHubWorkItemRef>,
  workItemRef: string,
): Promise<readonly string[]> {
  try {
    const issue = await api.get(
      `/repos/${reference.owner}/${reference.repository}/issues/${reference.number}`,
    );
    if (issue.status < 200 || issue.status >= 300) {
      throw providerTagsFailure(issue.status, issue.body, issue.headers);
    }
    if (!isRecord(issue.body) || Object.hasOwn(issue.body, "pull_request")) {
      throw invalidTagsChangeRequest("The Work Item reference must identify a GitHub Issue.");
    }
    translateGitHubWorkItemResponse(issue, workItemRef);
    const labels = await api.get(
      `/repos/${reference.owner}/${reference.repository}/issues/${reference.number}/labels?per_page=100`,
    );
    return translateGitHubWorkItemLabelsResponse(labels, workItemRef);
  } catch (error) {
    throw normalizeTagsChangeError(error);
  }
}

async function requestGitHubLabels(
  api: NonNullable<ModuleHandlerContext["capabilities"]["githubApi"]>,
  reference: ReturnType<typeof parseGitHubWorkItemRef>,
  workItemRef: string,
  labels: readonly string[],
): Promise<void> {
  try {
    const response = await api.request({
      method: "POST",
      path: `/repos/${reference.owner}/${reference.repository}/issues/${reference.number}/labels`,
      body: { labels: [...labels] },
    });
    if (response.status < 200 || response.status >= 300) {
      throw providerTagsFailure(response.status, response.body, response.headers);
    }
  } catch (error) {
    throw normalizeTagsChangeError(error);
  }
}

async function removeGitHubLabel(
  api: NonNullable<ModuleHandlerContext["capabilities"]["githubApi"]>,
  reference: ReturnType<typeof parseGitHubWorkItemRef>,
  workItemRef: string,
  label: string,
): Promise<void> {
  try {
    const response = await api.request({
      method: "DELETE",
      path: `/repos/${reference.owner}/${reference.repository}/issues/${reference.number}/labels/${encodeURIComponent(label)}`,
    });
    if (response.status < 200 || response.status >= 300) {
      throw providerTagsFailure(response.status, response.body, response.headers);
    }
  } catch (error) {
    throw normalizeTagsChangeError(error);
  }
}

function providerTagsFailure(
  status: number,
  body: unknown,
  headers: Parameters<typeof mapGitHubWorkItemTagsError>[0]["headers"],
): GitHubTranslationError {
  const failure = mapGitHubWorkItemTagsError({
    status,
    body,
    ...(headers === undefined ? {} : { headers }),
  });
  return new GitHubTranslationError(failure.code, failure.message, failure.retryable);
}

function normalizeTagsChangeError(error: unknown): GitHubTranslationError {
  if (error instanceof GitHubTranslationError) return error;
  if (error instanceof GitHubApiError) {
    return new GitHubTranslationError(
      error.status === "unavailable" ? "github.work-item-unavailable" : "github.unauthorized",
      error.status === "unavailable"
        ? "GitHub Work Item service is temporarily unavailable; retry later."
        : "GitHub cannot access the requested repository.",
      error.status === "unavailable",
    );
  }
  return transientTagsChangeFailure("GitHub label change did not complete; retry later.");
}

function transientTagsChangeFailure(message: string): GitHubTranslationError {
  return new GitHubTranslationError("github.work-item-tags-failed", message, true);
}

function readTagsChangeRequest(
  value: Readonly<Record<string, unknown>>,
): GitHubWorkItemTagsChangeRequestedPayload {
  const request = {
    repositoryId: readTagsString(value, "repositoryId"),
    workItemRef: readTagsString(value, "workItemRef"),
    addTags: readTags(value, "addTags"),
    removeTags: readTags(value, "removeTags"),
  };
  if (request.addTags.length === 0 && request.removeTags.length === 0) {
    throw invalidTagsChangeRequest("At least one label must be added or removed.");
  }
  const removed = new Set(request.removeTags);
  if (request.addTags.some((tag) => removed.has(tag))) {
    throw invalidTagsChangeRequest("A label cannot be added and removed in the same request.");
  }
  return request;
}

function readTagsString(value: Readonly<Record<string, unknown>>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw invalidTagsChangeRequest(`The request ${field} field is invalid.`);
  }
  return candidate;
}

function readTags(value: Readonly<Record<string, unknown>>, field: string): readonly string[] {
  const candidate = value[field];
  if (!Array.isArray(candidate) || candidate.length > 100) {
    throw invalidTagsChangeRequest(`The request ${field} field is invalid.`);
  }
  const tags = candidate.map((tag) => {
    if (typeof tag !== "string" || tag.trim() === "" || tag.length > 200) {
      throw invalidTagsChangeRequest(`The request ${field} field is invalid.`);
    }
    return tag;
  });
  if (new Set(tags).size !== tags.length) {
    throw invalidTagsChangeRequest(`The request ${field} field contains duplicates.`);
  }
  return tags;
}

interface TagsChangeReceipt {
  readonly repositoryId: string;
  readonly workItemRef: string;
  readonly addTags: readonly string[];
  readonly removeTags: readonly string[];
  readonly observedTags: readonly string[];
}

function encodeTagsChangeReceipt(
  request: GitHubWorkItemTagsChangeRequestedPayload,
  observedTags: readonly string[],
): string {
  return `github-tags-change:v1:${JSON.stringify({
    repositoryId: request.repositoryId,
    workItemRef: request.workItemRef,
    addTags: [...request.addTags].sort(),
    removeTags: [...request.removeTags].sort(),
    observedTags: [...observedTags],
  })}`;
}

function decodeTagsChangeReceipt(value: string | undefined): TagsChangeReceipt | undefined {
  if (value === undefined || !value.startsWith("github-tags-change:v1:")) return undefined;
  try {
    const parsed = JSON.parse(value.slice("github-tags-change:v1:".length)) as unknown;
    if (!isRecord(parsed)) return undefined;
    const fields = ["repositoryId", "workItemRef", "addTags", "removeTags", "observedTags"];
    if (
      fields.some((field) => !Object.hasOwn(parsed, field)) ||
      typeof parsed["repositoryId"] !== "string" ||
      typeof parsed["workItemRef"] !== "string" ||
      !parsed["addTags"] ||
      !parsed["removeTags"] ||
      !parsed["observedTags"] ||
      ![parsed["addTags"], parsed["removeTags"], parsed["observedTags"]].every(
        (tags) => Array.isArray(tags) && tags.every((tag) => typeof tag === "string"),
      )
    ) {
      return undefined;
    }
    return parsed as unknown as TagsChangeReceipt;
  } catch {
    return undefined;
  }
}

function sameTagsChangeRequest(
  receipt: TagsChangeReceipt,
  request: GitHubWorkItemTagsChangeRequestedPayload,
): boolean {
  return (
    receipt.repositoryId === request.repositoryId &&
    receipt.workItemRef === request.workItemRef &&
    JSON.stringify([...receipt.addTags].sort()) === JSON.stringify([...request.addTags].sort()) &&
    JSON.stringify([...receipt.removeTags].sort()) ===
      JSON.stringify([...request.removeTags].sort())
  );
}

function invalidTagsChangeRequest(message: string): GitHubTranslationError {
  return new GitHubTranslationError("github.work-item-tags-invalid", message, false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publishCreated(
  ctx: ModuleHandlerContext,
  created: ReturnType<typeof translateGitHubPullRequestResponse>,
): void {
  ctx.publish({
    ...GITHUB_CHANGE_REQUEST_CREATED,
    subject: { type: "change-request", ref: created.changeRequestRef },
    repositoryId: created.repositoryId,
    payload: { ...created },
  });
}

function readCreationRequest(
  value: Readonly<Record<string, unknown>>,
): GitHubChangeRequestCreationRequestedPayload {
  const repositoryId = readString(value, "repositoryId");
  const workItemRef = readString(value, "workItemRef");
  const baseBranch = readString(value, "baseBranch");
  const headBranch = readString(value, "headBranch");
  const headCommit = readString(value, "headCommit");
  const title = readString(value, "title");
  const description = readString(value, "description");
  const draft = value["draft"];
  if (draft !== undefined && typeof draft !== "boolean") {
    throw invalidRequest("The request draft field is invalid.");
  }
  return {
    repositoryId,
    workItemRef,
    baseBranch,
    headBranch,
    headCommit,
    title,
    description,
    ...(draft === undefined ? {} : { draft }),
  };
}

function readString(value: Readonly<Record<string, unknown>>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw invalidRequest(`The request ${field} field is invalid.`);
  }
  return candidate;
}

function invalidRequest(message: string): GitHubTranslationError {
  return new GitHubTranslationError("github.change-request-invalid", message, false);
}

function readFailure(error: unknown): {
  readonly code: GitHubTranslationErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly error: Error;
} {
  if (error instanceof GitHubTranslationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      error,
    };
  }
  return {
    code: "github.change-request-create-failed",
    message: "GitHub did not complete the pull request operation.",
    retryable: true,
    error: new GitHubTranslationError(
      "github.change-request-create-failed",
      "GitHub did not complete the pull request operation.",
      true,
    ),
  };
}
