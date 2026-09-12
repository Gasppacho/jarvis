# Error Codes v1

Errors crossing the Local API or stored as terminal Execution errors use stable codes. Messages may improve without changing the code.

## System and API

| Code | Retryable | Meaning |
|---|---:|---|
| `system.engine-start-failed` | No | Embedded Engine did not complete handshake |
| `system.engine-already-running` | No | Another Engine already owns the requested data root |
| `system.api-version-incompatible` | No | Shell and Engine API versions cannot communicate |
| `api.unauthorized` | No | Missing or invalid session token |
| `api.host-not-allowed` | No | Request did not address the loopback interface |
| `api.invalid-request` | No | OpenAPI/JSON Schema validation failed |
| `system.internal-error` | Maybe | Engine failed to handle the request; detail stays in the log |
| `system.storage-unavailable` | Maybe | SQLite or Application Support unavailable during bootstrap |
| `engine.database-unavailable` | Yes | Engine remains reachable but project operations are suspended because SQLite is unavailable |

## Project

| Code | Retryable | Meaning |
|---|---:|---|
| `repository.path-invalid` | No | Repository discovery/import received a missing, relative, inaccessible or non-directory path |
| `repository.not-git` | No | Repository import received a directory that is not a Git repository |
| `project.already-imported` | No | The canonical repository path is already bound to a Project |
| `project.config-invalid` | No | Portable configuration fails schema/semantic validation |
| `project.bindings-invalid` | No | Local Bindings fail schema, project identity or declared-slot validation |
| `project.composition-incomplete` | No | Draft has no Module Instance or Project Slot yet |
| `project.repository-write-failed` | Maybe | Atomic `.jarvis/project.yaml` replacement failed before SQLite was changed |
| `project.repository-compensation-failed` | No | SQLite rejected a replacement and the previous repository file could not be restored; manual inspection is required |
| `project.not-found` | No | No Project with the requested ID exists in this installation |
| `project.active` | No | An active Project must be paused before deletion |
| `project.activation-not-validated` | No | Activation found no successful validation report for the composition and Local Bindings saved right now |
| `project.activation-report-stale` | No | Activation's `compositionFingerprint` no longer matches the Portable Configuration or Local Bindings saved right now; the report is not silently revalidated |
| `project.binding-missing` | No | Required slot has no Local Binding |
| `project.capability-unresolved` | No | Bound resource does not provide the required capability |
| `project.request-orphaned` | No | Request contract has no active consumer |
| `project.request-ambiguous` | No | Request contract resolves to multiple consumers |
| `project.module-package-unavailable` | No | A saved Module Instance references a Module Package that is unknown, rejected or no longer bundled; the finding targets its `/moduleId` field |
| `project.instance-config-invalid` | No | Saved Module Instance configuration no longer satisfies its available bundled package schema |
| `project.contract-incompatible` | No | Producer and consumer edge declarations disagree on event type, version or kind |
| `project.repository-unavailable` | Maybe | Repository grant/path cannot be resolved |
| `project.resource-degraded` | Maybe | Runtime/connection/MCP became unavailable |

## Connections

| Code | Retryable | Meaning |
|---|---:|---|
| `connection.provider-unsupported` | No | The requested connection provider is not bundled |
| `connection.secret-ref-invalid` | No | The request supplied a credential value or unsupported reference instead of an opaque `gh://account` reference |
| `connection.not-found` | No | The requested connection is not registered |

## Eventing

| Code | Retryable | Meaning |
|---|---:|---|
| `event.envelope-invalid` | No | Event Envelope validation failed |
| `event.payload-invalid` | No | Payload contract validation failed |
| `event.type-not-declared` | No | Module attempted an undeclared publication |
| `delivery.not-found` | No | No Dead Letter exists with the requested Delivery ID, or its replay is already held by a live lease |
| `delivery.retry-exhausted` | No | Retry limit reached; delivery is dead-lettered |

Permanent structured handler failures keep the module/provider code supplied by
the handler in the Dead Letter. `delivery.retry-exhausted` is used when a
retryable Delivery reaches its attempt maximum; `delivery.not-found` is emitted
when replay is requested for a missing Dead Letter or for one already held by a
live replay lease. Unknown failures and bounded failures while recording an
outcome use `system.internal-error`. The current runtime emits no generic
`delivery.handler-failed` or `delivery.partition-busy` code.

`system.delivery-lease-lost` is an internal `ConsumeResult` used to discard a
stale worker's outcome. It is neither returned as a Local API `ErrorResponse`
nor persisted as a terminal Execution error, so it is intentionally outside
this public v1 catalog.

## Executions

| Code | Retryable | Meaning |
|---|---:|---|
| `execution.not-found` | No | No Execution with the requested ID exists |
| `execution.not-cancellable` | No | The Execution is not in a cancellable running state |

## Workspace and Git

| Code | Retryable | Meaning |
|---|---:|---|
| `workspace.allocation-failed` | Maybe | Worktree/lease could not be created |
| `workspace.branch-conflict` | No | The requested repository branch already has an active workspace lease |
| `workspace.concurrency-limit` | No | The Project already uses its configured maximum of concurrent workspaces |
| `workspace.lease-not-found` | No | The execution has no Workspace Lease to release |
| `workspace.path-violation` | No | Operation attempted to escape allowed workspace |
| `workspace.release-failed` | Maybe | Worktree cleanup or Lease release could not complete |
| `git.base-not-found` | No | Configured base branch/revision is absent |
| `git.no-changes` | No | Agent produced no committable change |
| `git.validation-failed` | No | Required Project Commands remain failing |
| `git.commit-failed` | Maybe | Commit command failed |
| `git.push-failed` | Maybe | Push failed without confirmed remote state |

## Agent Runtime

| Code | Retryable | Meaning |
|---|---:|---|
| `agent.runtime-unavailable` | Maybe | Bound executable/runtime cannot run |
| `agent.runtime-unauthenticated` | No | User must authenticate/reconnect |
| `agent.run-failed` | Depends | Adapter returned a terminal failure |
| `agent.codex.turn-failed` | Yes | Codex reported that the current turn failed |
| `agent.codex.process-failed` | Yes | Codex exited unsuccessfully before a reliable terminal result |
| `agent.codex.missing-result` | No | Codex ended without reporting a terminal result |
| `agent.codex.invalid-json` | No | Codex emitted a stdout line that is not valid JSON |
| `agent.codex.unauthenticated` | No | Codex refused the turn because the user is not authenticated |
| `agent.codex.spawn-failed` | No | The bound Codex executable could not be started |
| `agent.run-timed-out` | Maybe | Configured timeout elapsed |
| `agent.run-cancelled` | No | User/system cancelled the run |
| `agent.output-limit-exceeded` | No | Output exceeded configured safe limit |

## GitHub

| Code | Retryable | Meaning |
|---|---:|---|
| `github.unauthorized` | No | Connection cannot access the resource |
| `github.rate-limited` | Yes | Retry after provider reset time |
| `github.branch-not-found` | No | Requested head branch is not visible remotely |
| `github.change-request-invalid` | No | Provider rejected PR input semantically |
| `github.change-request-create-failed` | Depends | Creation failed without a more specific code |
| `github.poll-failed` | Yes | Inbound observation failed transiently |
| `github.work-item-unavailable` | Yes | GitHub could not temporarily serve the requested Work Item |
| `github.work-item-unauthorized` | No | Project GitHub connection cannot read the requested Work Item; revalidate it |
| `github.work-item-read-failed` | No | Requested Work Item is missing, malformed, mismatched, or closed |

## Error envelope rules

- Never include secret values or unredacted process environment.
- `retryable` is decided at the adapter/application boundary and may be overridden only by a more restrictive policy.
- User messages state the impacted Project/module and one concrete remediation.
- Unknown external errors map to a stable context code with technical detail in a redacted Artifact.
