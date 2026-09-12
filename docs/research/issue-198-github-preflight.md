# GitHub read-only preflight — issue #198

Checked 2026-09-12 against Context7 `/websites/github_en_rest` and GitHub's official REST documentation. These are API facts and implementation guidance, not a claim that live workflow acceptance was executed.

## Read probes

| Check | GET request | Evidence and boundary |
| --- | --- | --- |
| Repository | `/repos/{owner}/{repo}` | Requires Metadata read for private resources. Response includes repository settings such as `has_issues`, `archived`, `disabled`, and may include `permissions.pull/push/admin`. Use this to establish repository access and reported repository role. It does not itself execute or guarantee subsequent writes. [Repository API](https://docs.github.com/en/rest/repos/repos#get-a-repository) |
| Readiness label | `/repos/{owner}/{repo}/labels/{name}` | Requires Issues read OR Pull requests read for private resources; success proves label existence. URL-encode the complete label as one path segment. Do not create a missing label. [Label API](https://docs.github.com/en/rest/issues/labels#get-a-label), [URL encoding](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#404-not-found-for-an-existing-resource) |
| Candidate issues | `/repos/{owner}/{repo}/issues?state=open&labels=…` | Requires Issues read for private resources. Paginate; exclude entries with `pull_request`. Empty results are a valid list response. Use `state=all` without the readiness filter if a separate existing issue is needed to check dependency reading. [Issues API](https://docs.github.com/en/rest/issues/issues#list-repository-issues) |
| Native blockers | `/repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by` | Requires Issues read for private resources. `issue_number` is mandatory. Supports `page` and `per_page` (default 30, maximum 100). Read every page before concluding zero open blockers. Report open dependency numbers/references; never substitute a `blocked` label. [Dependencies API](https://docs.github.com/en/rest/issues/issue-dependencies#list-dependencies-an-issue-is-blocked-by) |

These endpoints permit unauthenticated public-resource access, but Jarvis still needs its project-bound authenticated connection. Public GET success cannot prove that a token possesses private-resource or write permissions. [Permissions reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)

## Empty repository and capability limits

There is no repository-level dependency-read probe documented by the dependency API: its GET route requires a real issue number. **Inference:** with no actual issues, successful issue listing establishes the shared Issues-read prerequisite, but does not execute the dependency route. Keep configuration readiness separate from an empty candidate preview; explicitly describe this limitation instead of inventing an issue number, treating its 404 as success, or writing a probe issue. When a real issue exists, execute its scoped `blocked_by` GET. [Dependencies API](https://docs.github.com/en/rest/issues/issue-dependencies#list-dependencies-an-issue-is-blocked-by)

`X-Accepted-GitHub-Permissions` describes permissions required by an endpoint, not permissions granted to the current token. Repository roles and token permissions are separate requirements. A 404 can conceal inaccessible private resources, so missing-label/issue diagnostics must acknowledge inaccessible resources; 403 can also mean rate limiting, and 429 is rate limiting. Keep diagnostics sanitized and actionable. [REST troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api)

All probes remain GET-only. The preflight must neither infer that write operations were tested nor perform comments, labels, branches, commits, pushes, pull requests, or dependency mutations to discover capability.
