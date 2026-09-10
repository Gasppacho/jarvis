import type { ModuleHandler, ModuleHandlerContext } from "../../../module-sdk/src/index.js";
import {
  buildGitHubPullRequestBody,
  GitHubTranslationError,
  parseGitHubWorkItemRef,
  translateGitHubPullRequestResponse,
  type GitHubChangeRequestCreationRequestedPayload,
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

  const githubApi = ctx.capabilities.githubApi;
  if (githubApi === undefined) {
    throw new GitHubTranslationError(
      "github.change-request-create-failed",
      "The GitHub API capability is unavailable.",
      true,
    );
  }
  const externalMappings = ctx.capabilities.externalMappings;
  if (externalMappings === undefined) {
    throw new GitHubTranslationError(
      "github.change-request-create-failed",
      "The external mapping capability is unavailable.",
      true,
    );
  }
  externalMappings.recordAttempt(idempotencyKey);

  const response = await githubApi.request({
    method: "POST",
    path: `/repos/${reference.owner}/${reference.repository}/pulls`,
    body: { ...buildGitHubPullRequestBody(request) },
  });
  const created = translateGitHubPullRequestResponse(response, request);
  externalMappings.recordResource({
    idempotencyKey,
    resourceRef: created.changeRequestRef,
  });
  ctx.publish({
    ...GITHUB_CHANGE_REQUEST_CREATED,
    subject: { type: "change-request", ref: created.changeRequestRef },
    repositoryId: created.repositoryId,
    payload: { ...created },
  });
  return created;
};

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
