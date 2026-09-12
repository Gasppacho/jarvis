# Issue #197 — Runtime readiness evidence

Verified on 2026-09-12 in an isolated worktree, based on `c2e83d4`
(includes #190, #192, #196 and the concurrent #193/#194 deliveries).

## Delivered behavior and proof

| Requirement | Executed evidence |
| --- | --- |
| Human Codex candidates, zero/one/multiple, explicit choice | `ProjectRuntimeTests`: no implicit binding; human name/version presentation; Engine binding-candidates integration |
| Local binding/profile, portable preservation, project isolation | `project-runtime-bindings.integration.test.ts`: two projects, approved profile, exact child probe environment, unchanged portable API document and repository file |
| Readiness, missing binary, permissions, incompatible version/capability, authentication, bounded errors | Real Local API with a controlled executable; only `--version` and `login status`, never `exec`; no Execution created; native presentation covers all seven statuses |
| Reopening, stale replies, incomplete drafts, Review and activation | XCTest retains selected binding but returns to unchecked; late check discarded; unsaved draft refuses check; current valid composition cannot bypass missing runtime readiness |
| Concurrent selections and failed reload | Deferred API XCTest keeps binding-write exclusion through reload; failed reload invalidates cached full-replacement bindings before another write |
| Optional unused runtime slot | Integration confirms it does not impose runtime readiness on an otherwise non-agent workflow |
| Sensitive presentation and output | No executable/profile value in readiness response; API errors sanitized; controlled child test proves temporary profile paths are redacted |
| New/existing template policy | Only the new template gets PATH/HOME/CODEX_HOME names; explicit profile choice supplies local values. Existing portable configuration and agent:ready rule remain unchanged; new template uses ready-for-agent |

No #197 test starts a real Codex execution or writes to GitHub. Integration
uses temporary repositories, a real Engine/SQLite and controlled executables.
XCTest verifies the presentation/actions consumed by native SwiftUI; no manual
VoiceOver, theme screenshots or XCUITest walkthrough is claimed.

## Commands and observed results

- `rtk pnpm exec vitest run --project integration apps/engine/test/project-runtime-bindings.integration.test.ts`: **4 passed**.
- `rtk pnpm exec vitest run --project unit packages/agent-runtime/src/child-process-agent-run.test.ts`: **3 passed**; new temporary-path regression first failed with raw paths, then passed after the shared sanitizer correction.
- `rtk pnpm exec vitest run --project unit packages/agent-runtime/src/codex-runtime.test.ts`: **26 passed** in isolation after an earlier 500 ms version-probe scheduling failure during the full parallel suite.
- `rtk pnpm test:swift`: **167 passed**, zero failures on final code.
- `rtk pnpm build:app`: **passed**, release app assembled.
- `rtk pnpm exec vitest run --project integration`: executed; failures investigated rather than disabled.
- `rtk pnpm verify`: executed, including a final run via `rtk proxy env VITEST_MAX_WORKERS=4 pnpm verify`. Worker count bounds machine contention; all tests and assertions remain enabled. Generation, contracts (17 schemas, 38 API paths), formatting, typecheck, architecture, Engine build and **344 unit tests passed**. Integration: **341 passed, 2 failed**. The pipeline therefore remains **red**, not fully verified. App build and Swift tests were run separately after that stop.

## Baseline comparison and remaining global gate failures

A second clean detached worktree at `c2e83d4` reproduced both remaining failures
without any #197 source changes. `git diff --exit-code` was clean there.
Comparison command:

```sh
rtk proxy env VITEST_MAX_WORKERS=4 pnpm exec vitest run --project integration \
  apps/engine/test/github-polling.integration.test.ts \
  apps/engine/test/github-change-request.integration.test.ts \
  apps/engine/test/execution-cancellation.integration.test.ts
```

The remaining failures are both in `github-polling.integration.test.ts`:

1. `admits one already-labelled open issue from its current GitHub state`: the expected idempotency key includes `:github:main:`, while main emits `:main:`.
2. `waits for an open native blocker, then rechecks complete issue and dependency pages`: the fixture waits for two ready events; main does not reach that count under the admission policy.

The baseline comparison also reproduced a timing-dependent extra simulated PR
in the retry test. That test passed in the final complete integration run.
No polling, admission or PR assertions were changed to bypass these failures.
The relevant PATH defect was reproduced on the initial baseline too and fixed
at the shared runtime output sanitizer; its fixture now uses a deterministic
profile instead of inheriting pnpm command-specific PATH prefixes.

## Review

Independent Standards and Spec reviews completed before commit. Findings
corrected and re-reviewed: optional-slot activation, unknown runtime metadata,
unsaved-profile certification, concurrent full-binding replacement, and stale
cached bindings after reload failure. **No remaining review findings.**

The #197 change is implemented and its targeted checks pass. This evidence does
not claim a green repository-wide gate or a manual UI acceptance walkthrough.
