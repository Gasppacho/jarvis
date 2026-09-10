/** Build-time entrypoint for the official GitHub Module Package. */
export {};

export {
  GitHubCliCredentialResolver,
  type GitHubCredentialResolution,
  type GitHubCredentialResolutionPort,
  type GitHubCredentialResolverOptions,
} from "./credentials.js";

export {
  GitHubProviderCheckAdapter,
  type GitHubProviderCheckOptions,
  type GitHubProviderCheckPort,
  type GitHubProviderCheckResult,
  type GitHubProviderCheckStatus,
} from "./provider-check.js";
