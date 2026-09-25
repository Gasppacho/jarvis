# Pull Request default branch — 2026-09-24

Checked against GitHub's current REST documentation and Jarvis's Pull Request flow. This is API and code-path research, not a live repository probe.

## Source of truth

GitHub's `GET /repos/{owner}/{repo}` response includes `default_branch`; for fine-grained tokens on private repositories, the endpoint requires repository Metadata read access. Use that response field as the repository's configured default branch. [Get a repository](https://docs.github.com/en/rest/repos/repos#get-a-repository)

GitHub interprets closing keywords such as `Closes #N` only when the pull request targets the repository's default branch; the issue closes when that PR is merged into that branch. A keyword on a PR targeting another branch creates no link and has no closing effect. [Linking a pull request to an issue](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)

## Original issue

`ModuleHandlerContext.repositoryDefaultBranch` is currently local Git `HEAD`, not GitHub metadata: [`discoverRepository`](../../apps/engine/src/projects/discovery.ts#L56-L77) calls [`readHead`](../../apps/engine/src/projects/discovery.ts#L272-L281), which reads `.git/HEAD` and extracts `refs/heads/<name>`. The engine invokes discovery on the Project's locally bound repository path ([`main.ts`](../../apps/engine/src/main.ts#L503-L526)) and injects the result into the handler context ([`delivery-consumer.ts`](../../apps/engine/src/executions/delivery-consumer.ts#L1136-L1144)). For a normal checkout this is its checked-out branch, not the remote repository's configured default.

Development copies that value into `development.implementation.completed.baseBranch`. Before this change, Pull Request used it as the PR base and compared it to the same local context value before appending `Closes #N`. That could choose a checked-out feature branch and did not establish that GitHub would honor the closing keyword.

## Smallest existing integration

The raw, project-bound GitHub client already exists as `ctx.capabilities.githubApi` ([SDK type](../../packages/module-sdk/src/index.ts#L43-L56), [capability](../../packages/module-sdk/src/index.ts#L189-L203)). Pull Request now declares `github.api` alongside `work-items.read`, bound to `sourceControl` ([manifest](../../packages/modules/pull-request/module.manifest.yaml)). The resolver exposes the raw client when the module explicitly requires `github.api`; `work-items.read` exposes the higher-level Work Item adapter ([resolver](../../apps/engine/src/executions/capabilities.ts#L288-L300)).

Pull Request GETs `/repos/${owner}/${repo}`, validates a successful response with a non-empty string `default_branch`, and uses that value for the outgoing Change Request's `baseBranch`. It appends `Closes #N` and fails preparation if the lookup fails or the field is malformed, rather than guessing from local `HEAD`. The end-to-end test sets the local completion base to `main` and GitHub's default to `release`, then verifies that the PR targets `release` and carries `Closes #16`.
