import type { ModuleHandler, ModuleHandlerContext } from "../../../module-sdk/src/index.js";
import {
  buildGitHubPullRequestBody,
  GitHubTranslationError,
  parseGitHubWorkItemRef,
  translateGitHubPullRequestMapping,
  translateGitHubPullRequestLookupResponse,
  translateGitHubPullRequestResponse,
  type GitHubChangeRequestCreationRequestedPayload,
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

/** Handles one explicitly targeted Change Request creation request. */
export const handleChangeRequestCreationRequested: ModuleHandler = async (
  ctx: ModuleHandlerContext,
) => {
  const request = readCreationRequest(ctx.event.payload);
  const reference = parseGitHubWorkItemRef(request.workItemRef);
  if (ctx.repositoryId !== request.repositoryId) {
    throw invalidRequest("The request repository does not match its Event repository.");
  }
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
          `/repos/${reference.owner}/${reference.repository}/pulls?head=${encodeURIComponent(request.headBranch)}&state=open`,
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
      path: `/repos/${reference.owner}/${reference.repository}/pulls`,
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
