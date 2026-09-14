# Issue #235 — L15 final receipt

Date: 2026-09-14. Worktree: `/private/tmp/jarvis-issue-235`. Branch:
`agent/l15-final-receipt`. Base: `origin/main` at `2e5ab871fe348add3975be309c5eb48f1d69d38e`.

This receipt records evidence executed from this worktree. It keeps three
proof classes separate: automated Harness evidence, native app evidence, and
an authorized GitHub/Codex dogfood run.

## Harness evidence

The existing Application Harness was reused. It starts the real Engine and
official fixed modules with real temporary SQLite, Git repositories and bare
remotes; GitHub and Agent Runtime are doubles at their external boundaries.
SQLite, Git and Eventing are not mocked.

| Scenario | Existing proof | Result |
| --- | --- | --- |
| GitHub observation only, pagination, cursor/restart and verified dependency state | `github-polling.integration.test.ts` | Pass in the full integration run |
| Fixed GitHub → Development → pushed branch → one PR, repeated observations | `reference-workflow-fixed.integration.test.ts`, `reference-workflow-pull-request.integration.test.ts` | Pass in the serial L15 matrix |
| Label mutations, ordering, idempotence and crash recovery | `github-change-request.integration.test.ts` | Pass in the serial L15 matrix |
| Cyclic graph and unresolved/orphaned routes | `composition-graph.integration.test.ts`, `composition-choices.integration.test.ts` | Pass in the full integration run |
| Exact scope A while B is also ready, project isolation and no cross-project delivery | `github-polling.integration.test.ts`, `runtime-isolation.integration.test.ts`, `project-overview.integration.test.ts` | Pass in the full integration run |
| Incomplete provider read/pagination, blocked native dependency and no start | `github-polling.integration.test.ts`, `reference-workflow-first-run.integration.test.ts` | Pass in the full integration run |
| Label removal/re-addition, pause versus cancellation and terminal no-redelivery | `reference-workflow-fixed.integration.test.ts`, `execution-cancellation.integration.test.ts`, `development.integration.test.ts` | Pass in the serial L15 matrix |
| Crash at admission, dispatch, push and Change Request boundaries | `github-polling.integration.test.ts`, `development-push-recovery.integration.test.ts`, `github-change-request.integration.test.ts`, `durability.integration.test.ts` | Pass in the full integration run |
| Guided migration with historical label/scope, custom refusal, backup and restart; legacy removal remains inactive | `guided-migration.integration.test.ts`, `legacy-rules-retirement.integration.test.ts` | Pass in the serial L15 matrix |

The focused command was:

```sh
rtk pnpm exec vitest run --project integration \
  apps/engine/test/reference-workflow-fixed.integration.test.ts \
  apps/engine/test/reference-workflow-first-run.integration.test.ts \
  apps/engine/test/reference-workflow-pull-request.integration.test.ts \
  apps/engine/test/reference-workflow-correlation.integration.test.ts \
  apps/engine/test/reference-workflow-pushed-branch.integration.test.ts \
  apps/engine/test/reference-workflow-redelivery.integration.test.ts \
  apps/engine/test/guided-migration.integration.test.ts \
  apps/engine/test/legacy-rules-retirement.integration.test.ts \
  apps/engine/test/execution-cancellation.integration.test.ts \
  apps/engine/test/development-push-recovery.integration.test.ts \
  apps/engine/test/github-polling.integration.test.ts \
  apps/engine/test/github-change-request.integration.test.ts \
  --pool=forks --maxWorkers=1
```

Observed result: **12 test files passed, 58 tests passed**. The serial option
is material: an initial attempt launched two Vitest builds concurrently and
hit `ENOTEMPTY` in `dist/engine`; that attempt is not evidence.

The full integration command with bounded Vitest workers was:

```sh
rtk proxy env VITEST_MAX_WORKERS=4 pnpm test:integration
```

Observed result: **52 test files passed, 400 tests passed**.

The required unmodified command was also executed exactly:

```sh
rtk pnpm verify
```

Observed results: contracts (**21 schemas, 9 event examples, 4 manifests, 47
API paths**), formatting, TypeScript, architecture (**220 modules, 914
dependencies**), Engine build, and **372 unit tests passed**. The first run ended
at **397/400** integration tests and the final rerun at **399/400**, with these
existing timing/concurrency failures observed across the two runs:

- `reference-workflow-pull-request.integration.test.ts`: 4 executions instead
  of 3;
- `github-polling.integration.test.ts`: one rate-limit event observed where the
  assertion expected zero;
- `runtime-isolation.integration.test.ts`: one project was not completed when
  inspected.

Each failed test passed alone with `--pool=forks --maxWorkers=1`, and the full
integration suite passed with `VITEST_MAX_WORKERS=4`. No production or test
source was changed to hide these failures. Because the exact required command
is red on this base, this criterion remains partial pending a stable default
gate or an accepted baseline disposition.

The final bounded full gate was then run with:

```sh
rtk proxy env VITEST_MAX_WORKERS=4 pnpm verify
```

Observed result: **exit 0**, contracts, formatting, typecheck, architecture,
**372 unit tests**, **400 integration tests**, packaged app build, and **202
Swift tests** passed. This is a reproducible bounded verification command; it
does not change the status of the exact unbounded command above.

The remaining checks completed separately:

```sh
rtk pnpm build:app
rtk pnpm test:swift
```

Both passed. The packaged app was assembled at `dist/Jarvis.app`; Swift tests
reported **202 tests passed**.

## Native app evidence

The packaged app was launched with the prescribed isolated data root:

```sh
rtk proxy open -n dist/Jarvis.app --args \
  --data-root /tmp/jarvis-issue-235-native-20260914-0928
```

The process started and created the isolated SQLite database and lock files.
At capture time `ioreg` reported `IOConsoleLocked = Yes`. `screencapture` wrote
`/tmp/jarvis-issue-235-native-locked.png`, but visual inspection found a black
3024×1964 image. It is retained only as a failed capture attempt. There is no
valid 1100×800 or 1512×949 light/dark capture, and no native keyboard,
VoiceOver, arrow navigation or restart walkthrough was observed in this run.

The Swift model tests and successful app build remain automated evidence. They
do not substitute for the missing interactive native evidence.

## Dogfood protocol and blocker

No GitHub repository, account, issue, branch or budget was explicitly
authorized for this worktree. No external repository was mutated and no real
Codex execution was started. Existing historical references to other runs in
`PROGRESS.md` are not counted as an L15 run.

To restart the blocked proof, provide an explicitly authorized sandbox
repository and a benign dedicated issue. Then record, before activation:

1. repository owner/name, issue number and allowed budget;
2. the exact issue URL and the project scope shown by the guide;
3. the created branch and commit SHA;
4. the resulting PR URL and timeline events;
5. the paused project state after the run, with no merge.

Until those values exist, the dogfood criterion is **blocked**, rather than
represented by a Fake GitHub, a Swift model test or the packaged build.

## Criterion matrix

| Criterion | Evidence from this receipt | Status |
| --- | --- | --- |
| Exact `rtk pnpm verify` and Harness matrix | Exact gate executed twice: 397/400 then 399/400 integration on the base; serial matrix 58/58 and bounded full integration 400/400 | Partial: default gate timing failures remain |
| No rule/target/slot setup and truthful readiness | Fixed-module Harness and Swift contract tests pass; no interactive first launch observed | Harness verified, native interaction pending |
| Unknown/blocked issue does not start; exact scope and pause survive restart | Polling, overview, fixed workflow, cancellation and restart tests pass | Verified by Harness |
| Migration/retrieval preserves history and old projects stay inactive | Guided migration and legacy retirement tests pass | Verified by Harness |
| Native captures and navigation | App build and isolated launch pass; console was locked and capture was black | Blocked |
| Real GitHub/Codex dogfood | No explicitly authorized sandbox was supplied | Blocked; restart point above |
| Human PR/review/merge boundary and no notarization claim | Tests stop at PR and no merge was requested; no notarization or Gatekeeper evidence claimed | Verified for boundary; release proof out of scope |

This is a partial receipt. It must not be used to announce complete L15
acceptance until the default gate disposition and the two blocked evidence
classes are resolved.
