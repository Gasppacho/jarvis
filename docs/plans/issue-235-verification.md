# Issue #235 — L15 final receipt

Date: 2026-09-14. Worktree: `/private/tmp/jarvis-issue-235`. Branch:
`agent/l15-final-receipt`. Initial L15 base: `origin/main` at
`2e5ab871fe348add3975be309c5eb48f1d69d38e`. The correction is integrated in
`fd753dc`, which contains test fix `bb1cbf7`.

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

The original 25 ms fixture interval exposed a real timing seam in the PR
assertion. `GitHubPollingScheduler` starts an immediate tick and continues
polling after each completed tick; each scan records a new observed fact and
observation revision. Under the full-suite scheduling load, another observed
fact could arrive while the PR chain was completing, producing a third
`development` execution even though durable admission and Pull Request
idempotence still prevented a second implementation or PR.

The smallest fix is isolated to this receipt test. In `bb1cbf7` (integrated as
`fd753dc`), the PR scenario uses a 60-second background interval and calls the
existing `/overview/refresh` endpoint once after seeding the issue. Repeated
observations remain covered by `reference-workflow-fixed.integration.test.ts`;
the exact three-execution assertion remains unchanged.

The corrected focused command passed **2/2 tests**, and the sequential focused
stress loop passed **20/20 runs**. The post-correction full integration run
passed **52 test files and 400 tests**.

The required unmodified command was then executed by the coordinator exactly
on integrated commit `fd753dc`:

```sh
rtk pnpm verify
```

Observed result at `fd753dc`: contracts (**21 schemas, 9 event examples, 4
manifests, 47 API paths**), formatting, TypeScript, architecture (**220
modules, 914 dependencies**), Engine build, **372/372 unit tests**, **400/400
integration tests**, packaged release app build, and **202/202 Swift tests**
all passed. The exact gate exited 0.

The final bounded full gate was then run with:

```sh
rtk proxy env VITEST_MAX_WORKERS=4 pnpm verify
```

Observed result: **exit 0**, contracts, formatting, typecheck, architecture,
**372 unit tests**, **400 integration tests**, packaged app build, and **202
Swift tests** passed. This remains a separate bounded Harness result; the final
exact gate result above is the authoritative gate evidence for `fd753dc`.

The remaining checks completed separately:

```sh
rtk pnpm build:app
rtk pnpm test:swift
```

Both passed. The packaged app was assembled at `dist/Jarvis.app`; Swift tests
reported **202 tests passed**.

## Native app evidence

The coordinator launched the final packaged app from the integration checkout
at commit `3dbd0e3`, using the isolated data root
`/tmp/jarvis-issue-235-native-final-20260914-1035`. The observed local path was:

`Add Project` → `Open` dialog → `/private/tmp/jarvis-issue-220-integration-v3`
→ import sheet → `Create draft` → `Workflow` → `Add GitHub` → `Access and
agent` → `Verification`.

No external GitHub mutation was performed.

The final screenshots are retained under
`/tmp/jarvis-issue-235-native-final-20260914-1035/`:

- `window-dark-1100x800.png`
- `window-dark-1512x949.png`
- `window-light-1100x800.png`
- `window-light-1512x949.png`
- `workflow-dark-1512x949.png`
- `workflow-light-1512x949.png`
- `workflow-light-1100x800.png`
- `after-draft-dark-1100x800.png`
- `after-github-dark-1100x800.png`
- `import-sheet-dark-1100x800.png`
- `access-dark-1100x800.png`
- `verification-dark-1100x800.png`
- `keyboard-workflow-1100x800.png`

The captures use `screencapture` of logical window bounds. The PNGs are Retina
2x: 1100×800 logical is 2200×1600 pixels, and 1512×949 logical is 3024×1898
pixels. Both dark and light appearances were tested, then the original dark
appearance was restored. The final window is 1100×800 logical at position
`0,33`.

System Events AX inspection exposed the following native evidence:

- Import sheet: `Ajouter un projet`, `Nom du projet` and the project description.
- Workflow: the project remote and `Brouillon · Workflow`.
- Access: `Brouillon · Accès et agent`; account entries `Gasppacho` and
  `QServicesEntreprise` with `Disponible` and explicit project authorization
  wording; `Non vérifié`; Codex search instructions; `Rechercher Codex`; and
  `Aide Codex`.
- Verification: `Brouillon · Vérification`, `Vérifiez la configuration...`, and
  verification disabled until the draft is saved.

For keyboard evidence, the AX Workflow stage control was focused and the macOS
Space key changed the visible stage from `Brouillon · Accès et agent` to
`Brouillon · Workflow`. A keyboard focus ring was visible on the Verification
control. AXPress was used only for the final local Verification navigation.

The earlier locked-console attempt and its black
`/tmp/jarvis-issue-235-native-locked.png` remain failed artifacts and are not
counted against this final native run. This evidence records the observed local
app flow, captures, AX labels and keyboard action; it does not establish an
authorized GitHub/Codex dogfood run.

## Dogfood protocol and blocker

No GitHub repository, account, issue, branch or budget was explicitly
authorized for this worktree, and no Codex runtime binding was authorized. No
external repository was mutated and no real Codex execution was started.
Existing historical references to other runs in `PROGRESS.md` are not counted
as an L15 run.

To restart the blocked proof, provide an explicitly authorized sandbox
repository and a benign dedicated issue. Then record, before activation:

1. repository owner/name, issue number and allowed budget;
2. the exact issue URL and the project scope shown by the guide;
3. an authorized Codex runtime binding and its allowed budget;
4. the created branch and commit SHA;
5. the resulting PR URL and timeline events;
6. the paused project state after the run, with no merge.

Until those values exist, the dogfood criterion is **blocked**, rather than
represented by a Fake GitHub, a Swift model test or the packaged build.

## Criterion matrix

| Criterion | Evidence from this receipt | Status |
| --- | --- | --- |
| Exact `rtk pnpm verify` and Harness matrix | Coordinator exact gate on `fd753dc`: 372/372 unit, 400/400 integration, release app build and 202/202 Swift; serial matrix 58/58 and focused correction stress 20/20 | Verified for automated gate and Harness |
| No rule/target/slot setup and truthful readiness | Fixed-module Harness plus the coordinator's observed local guide through Verification, including AX labels and disabled pre-save verification | Verified for supplied local native evidence |
| Unknown/blocked issue does not start; exact scope and pause survive restart | Polling, overview, fixed workflow, cancellation and restart tests pass | Verified by Harness |
| Migration/retrieval preserves history and old projects stay inactive | Guided migration and legacy retirement tests pass | Verified by Harness |
| Native captures and navigation | Final packaged app at `3dbd0e3`, 13 screenshots in the final data root, dark/light windows, AX labels and keyboard Space navigation observed | Verified for supplied native evidence |
| Real GitHub/Codex dogfood | No explicitly authorized sandbox or Codex runtime binding was supplied | Blocked; needs-info; restart point above |
| Human PR/review/merge boundary and no notarization claim | Tests stop at PR and no merge was requested; no notarization or Gatekeeper evidence claimed | Verified for boundary; release proof out of scope |

The exact automated gate and the supplied native local evidence are verified.
L15 remains **open / needs-info** for the authorized real GitHub/Codex dogfood
run. The required input is an explicitly authorized sandbox repository, account,
benign dedicated issue, budget and Codex runtime binding.
