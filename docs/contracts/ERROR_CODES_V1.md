# Error Codes v1

Errors crossing the Local API or stored as terminal Execution errors use stable codes. Messages may improve without changing the code.

## System and API

| Code | Retryable | Meaning |
|---|---:|---|
| `system.engine-start-failed` | No | Embedded Engine did not complete handshake |
| `system.api-version-incompatible` | No | Shell and Engine API versions cannot communicate |
| `api.unauthorized` | No | Missing or invalid session token |
| `api.host-not-allowed` | No | Request did not address the loopback interface |
| `api.invalid-request` | No | OpenAPI/JSON Schema validation failed |
| `system.internal-error` | Maybe | Engine failed to handle the request; detail stays in the log |
| `system.storage-unavailable` | Maybe | SQLite or Application Support unavailable |

## Project

| Code | Retryable | Meaning |
|---|---:|---|
| `project.config-invalid` | No | Portable configuration fails schema/semantic validation |
| `project.binding-missing` | No | Required slot has no Local Binding |
| `project.capability-unresolved` | No | Bound resource does not provide the required capability |
| `project.request-orphaned` | No | Request contract has no active consumer |
| `project.request-ambiguous` | No | Request contract resolves to multiple consumers |
| `project.repository-unavailable` | Maybe | Repository grant/path cannot be resolved |
| `project.resource-degraded` | Maybe | Runtime/connection/MCP became unavailable |

## Eventing

| Code | Retryable | Meaning |
|---|---:|---|
| `event.envelope-invalid` | No | Event Envelope validation failed |
| `event.payload-invalid` | No | Payload contract validation failed |
| `event.type-not-declared` | No | Module attempted an undeclared publication |
| `delivery.handler-failed` | Depends | Handler failed before terminal classification |
| `delivery.retry-exhausted` | No | Retry limit reached; delivery is dead-lettered |
| `delivery.partition-busy` | Yes | Another worker holds the partition lease |

## Workspace and Git

| Code | Retryable | Meaning |
|---|---:|---|
| `workspace.allocation-failed` | Maybe | Worktree/lease could not be created |
| `workspace.path-violation` | No | Operation attempted to escape allowed workspace |
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

## Error envelope rules

- Never include secret values or unredacted process environment.
- `retryable` is decided at the adapter/application boundary and may be overridden only by a more restrictive policy.
- User messages state the impacted Project/module and one concrete remediation.
- Unknown external errors map to a stable context code with technical detail in a redacted Artifact.
