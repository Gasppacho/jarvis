# Issue #191 — interrupted push recovery evidence

## Reproduction

Base: `29ec6c3e9a2d325f837b654607e766a15cc6d9e4`.
The Application Harness used a real Engine child, temporary SQLite, real Git
worktree/bare remote, a Fake Runtime child appending its PID to an observable
counter, and the existing HTTP fake GitHub.

With only the failpoints and test instrumentation added, both recovery tests
failed after SIGKILL and restart on the same data root/repository:

| Crash window | Observed remote SHA | Runtime calls after restart | Result |
|---|---|---:|---|
| Push before checkpoint | `321ff5704843c81aee0f9986c663b76b4c41b7b6` | 2 | No PR |
| Checkpoint before terminal Outbox | `4211bb39abbbaf726106b0e04459bfc4b29ae94e` | 2 | No PR |

Both Executions failed with
`The Agent Runtime created a commit before the Development commit.`
Startup had released the old workspace and Development ran the agent again
against its existing committed branch. This is an observed failure, not a
prediction from source inspection.

## Acceptance proofs

`apps/engine/test/development-push-recovery.integration.test.ts` covers:

| Requirement | Executed proof |
|---|---|
| Both crash windows | Exact remote SHA unchanged; original Execution completed; runtime count 1; one PR |
| Repeated recovery interruption | Two more checkpoint crashes, a crash after cleanup, restart and terminal redelivery; one commit/branch/PR/logical result |
| Correlation and idempotency | Original causation/correlation, existing PR key and completed External Mapping; one POST |
| Divergent remote | Changed remote ref untouched; no success Outbox or PR; retained workspace and diagnostic |
| Missing/partial validation | Permanent recovery diagnostic; no claimed validated PR; retained evidence across restart |
| User edits after crash | Dirty worktree preserved; no success publication |
| Remote/branch unavailable | Classified failure, no second agent; recovery succeeds after restoring access/ref |
| Bounded retry | Five attempts, retry-exhausted Dead Letter, successful explicit replay after repair |
| Live workspace ownership | Real live owner process, with present and temporarily missing directory; no lease release or agent start; recovery after owner exit |
| Cleanup | No active/retained lease remains on successful recovery |
| Production boundary | All three new failpoint identifiers in the production-bundle exclusion test |

The existing checkpoint-store tests additionally prove Project, Module Instance
and original input Event scoping, snapshot validation and sanitized title metadata.
The existing reference redelivery test continues to prove completed-event
redelivery without repeating external actions.

## Commands

- `rtk pnpm build:engine`: passed.
- `rtk pnpm exec vitest run --project integration apps/engine/test/development-push-recovery.integration.test.ts apps/engine/test/reference-workflow-redelivery.integration.test.ts apps/engine/test/development.integration.test.ts`: 38 tests passed, including 12 recovery scenarios.
- `rtk pnpm exec vitest run --project unit apps/engine/src/executions/checkpoints.test.ts`: 5 passed.
- `rtk pnpm typecheck`: passed.
- `rtk pnpm verify`: first attempt stopped on the Codex authentication-probe test (`version: null` versus `0.153.4`, 500 ms limit); no assertion or timeout was changed. The isolated Codex suite subsequently passed all 26 tests. The second full run passed 355 unit tests; its integration run exposed the cleanup fixture issue described below. The final complete rerun passed: 55 unit files / 355 tests, 46 integration files / 362 tests, production macOS build and 167 Swift tests. Contract generation/checks, formatting, TypeScript, architecture and the production failpoint exclusion test all passed. Its process exit code was 0.

## Review

Independent Standards and Spec reviews found and corrected two issues: recovery
must preserve the normal PR title, and a live owner's temporarily missing
workspace must not let startup release its lease or prune its Git registration.
Both behaviors are asserted in the recovery suite. Independent reinspection found no remaining Standards or Spec finding. The redaction test also asserts JSON-quoted secrets, token literals and file URIs. The complete suite also
exposed an older cleanup fixture that removed a directory while keeping the live
test worker as its lease owner. Its setup now explicitly models an abandoned
owner (`owner_pid = NULL`), like its neighboring stale-lease case; all cleanup
assertions remain unchanged. Its three integration tests pass. The distinct live
owner/missing directory case remains covered by the new recovery suite.

## Scope

No real GitHub or Codex execution is claimed. The workflow still ends at PR
creation; review and merge remain manual. No new workflow journal, database
migration, external dependency or event-schema version was added. Existing
checkpoints without complete validation evidence stop safely for inspection.
