/** Build-time entrypoint for the official GitHub Module Package. */
export {};

export {
  GitHubCliCredentialResolver,
  type GitHubCredentialResolution,
  type GitHubCredentialResolutionPort,
  type GitHubCredentialResolverOptions,
} from "./credentials.js";

export {
  GitHubCliAccountDiscovery,
  type GitHubAccountDiscovery,
  type GitHubAccountDiscoveryOptions,
  type GitHubAccountDiscoveryPort,
  type GitHubAccountDiscoveryResult,
} from "./account-discovery.js";

export {
  GitHubProviderCheckAdapter,
  type GitHubProviderCheckOptions,
  type GitHubProviderCheckPort,
  type GitHubProviderCheckResult,
  type GitHubProviderCheckStatus,
} from "./provider-check.js";

export {
  GitHubApiClient,
  GitHubApiError,
  type GitHubApiClientOptions,
  type GitHubApiFailure,
} from "./api-client.js";

export {
  GITHUB_CHANGE_REQUEST_CREATED,
  GITHUB_CHANGE_REQUEST_CREATION_FAILED,
  GITHUB_CHANGE_REQUEST_CREATION_REQUESTED,
  handleChangeRequestCreationRequested,
} from "./change-request-handler.js";

export {
  buildGitHubPullRequestBody,
  GitHubTranslationError,
  mapGitHubPullRequestError,
  latestGitHubIssueEvent,
  parseGitHubWorkItemRef,
  translateGitHubIssueEvents,
  translateGitHubWorkItemResponse,
  translateGitHubPullRequestMapping,
  translateGitHubPullRequestLookupResponse,
  translateGitHubPullRequestResponse,
  type GitHubChangeRequestCreationRequestedPayload,
  type GitHubChangeRequestCreatedPayload,
  type GitHubPullRequestCreationBody,
  type GitHubPullRequestErrorResponse,
  type GitHubResponseHeaders,
  type GitHubIssueEventTranslation,
  type GitHubIssueEventPosition,
  type GitHubTranslationErrorCode,
  type GitHubTranslationFailure,
  type GitHubWorkItemTagAddedPayload,
  type GitHubWorkItemReference,
} from "./translation.js";
