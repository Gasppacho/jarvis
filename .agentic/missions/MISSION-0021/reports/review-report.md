# MISSION-0021 — Review report (#55 — Activate from Project Wizard step 5)

## GUI session check

- Pre-build check: `ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked` → no output → **unlocked**.
- The session **locked mid-mission** (after the first screenshot attempt post-build). Detected immediately via the same `ioreg` check before the second capture; the black/unusable capture taken while locked (`01-fixture-project.png`) was deleted without being kept "just in case," and the mission paused rather than continuing to build/capture. Work resumed only after the coordinator and this agent both independently re-confirmed `ioreg` returned no output (unlocked).
- Every subsequent capture in this report was preceded by its own `ioreg` re-check; all returned unlocked.

## What was built

- `apps/macos/JarvisCore/APIClient/Projects.swift` — added `compositionFingerprint: String?` to `ProjectValidationReport` (and its private wire-decoding struct), decoded from the optional wire field. Optional because contracts/openapi/local-api.v1.yaml does not list it under the report's `required` — this was deliberate in #53 to avoid breaking 9 existing fixtures.
- `apps/macos/JarvisCore/APIClient/EngineClient.swift` — added `activateProject(projectId:compositionFingerprint:) async throws -> Project`, calling the generated `POST /v1/projects/{projectId}/activate` and mapping engine errors through the existing `EngineClientError.engineError` path (same pattern as every other mutating call in this file).
- `apps/macos/JarvisCore/ProjectConfigurationModel.swift` — added `ProjectActivationState` (`idle`, `activating`, `succeeded`, `rejected(code: String?, message: String)`, `transportFailure(String)`) and `activate(projectId:)`. It reads the *exact* currently-displayed report (`state.validation == .valid(report)` with `report.projectId == projectId`), refuses locally with `code: nil` (never an engine code) when there is no such report or when `report.compositionFingerprint == nil`, otherwise forwards the exact fingerprint to the engine. On success it calls `projects.refresh()` so the sidebar and header pick up the new `active` status from the engine — no client-side "active" flag is invented. `markValidationStale` (the existing path #45 already used for every composition/binding edit) now also resets `activation` to `.idle`, so a stale report cannot keep showing a previous activation failure. Added an internal `activationProvider` test seam mirroring the existing `validationReportProvider` seam.
- `apps/macos/JarvisCore/ProjectDetailPresentation.swift` — added `Validation.compositionFingerprint` (threaded through from the report) and a new `Activation` presentation struct, computed from `(ProjectActivationState, Validation, Project.Status)`. Every "not ready" explanation is `validation.activationReadinessExplanation` verbatim (the #45 vocabulary, not duplicated) except the one truly new condition: a current, successful report with no fingerprint, which gets one new sentence ("...refused rather than guessed..."). An already-`.active` Project always shows unavailable/"already active" regardless of local activation state. Added `Action.Asynchronous.activate` and wired it into the actions inventory next to `.validate`.
- `apps/macos/JarvisApp/Features/Projects/ProjectDetailView.swift` — added an `Activation` section, its own heading, its own icon/colour scheme (blue/green/red, never orange — orange is the Validation Report's palette), and — only for `.rejected`/`.transportFailure` — a separate bordered red panel titled "Activation error — not a validation finding" so an engine rejection can never be mistaken for a validation finding, per the acceptance criterion.
- `docs/product/UX.md` — replaced the sentence saying step 5 "sends no activation request" (true before this ticket, false after) with a paragraph in the existing French voice describing the `Activate` button, its fingerprint handling, its refusal without one, and the distinct rendering of a rejection.
- `apps/macos/JarvisAppTests/ProjectValidationTests.swift` — updated the one pre-existing test that asserted "step 5 exposes no callable activation request" (that assertion was #45's own scope boundary, now correctly obsolete) to include `activate` in the callable-operations set.

### How the fingerprint reaches the activate call

`ProjectConfigurationModel.activate(projectId:)` pulls it from `state(for: projectId).validation` — the same enum `ProjectDetailPresentation` reads for the "Ready to activate" text — not from a separate store. If that enum case is not `.valid(report)` for the *current* `projectId`, or `report.compositionFingerprint` is `nil`, the method never calls the engine; it sets `.rejected(code: nil, message: …)` directly. `code: nil` is the tell used everywhere (model, presentation, tests) to distinguish "the client refused before asking" from "the engine answered no."

## Tests

`apps/macos/JarvisAppTests/ProjectActivationTests.swift` (new, 11 tests, all passing):

- Presentation-level (no engine): every unavailable validation state reuses `activationReadinessExplanation` verbatim; enabled only for a current, successful, fingerprinted report; a report missing its fingerprint refuses with a distinct explanation (asserted); an already-`active` Project never offers `Activate`; a `.rejected`/`.transportFailure` activation state renders distinctly from validation findings (`validation.findings.isEmpty`, `validation.status` unaffected).
- Model-level, no real engine call (client-side refusal only): no current successful report → `rejected(code: nil, …)`; a current report with `compositionFingerprint: nil` → `rejected(code: nil, …)`.
- Model-level, injected `activationProvider` (mirrors the existing `validationReportProvider` test seam): an engine rejection (`project.activation-not-validated`) renders with its real code and leaves the still-current validation report untouched; a transport failure renders distinctly from an engine rejection; a success transitions `activation` away from any failure state and forwards the *exact* fingerprint of the displayed report (asserted via a capturing actor).
- **Real embedded engine** (`EngineSupervisor(resources: .developmentBuild())`, matching the file's own "highest realistic seam" convention): imports a real Project, forges only the Wizard's local belief that a current report exists (fingerprint `"aaa…a"`, 64 hex chars — a report the real engine never issued), then calls `activate()` with no `activationProvider`, so it hits the real `POST /activate`. Asserts the real engine returns a `project.activation-*` rejection and that `projects.detail(for:).project.status` stays `draft` afterward — "a failed activation leaves the displayed Project state consistent with the engine state," proven against the real engine, not a mock.

All existing `ProjectValidationTests` and `ProjectConfigurationTests` continued to pass unmodified except the one exhaustive-switch fix above (required by the compiler once `.activate` was added, not a behaviour change).

## Verify results

| Stage | Command | Result |
|---|---|---|
| Swift build | `swift build --package-path apps/macos` | Pass |
| Swift build (tests) | `swift build --package-path apps/macos --build-tests` | Pass |
| New tests only | `swift test --package-path apps/macos --filter ProjectActivationTests` | **11/11 passed** (2.9s; includes the real-engine test) |
| Regression | `swift test --package-path apps/macos --filter 'ProjectValidationTests\|ProjectConfigurationTests'` | **All passed** |
| Full `pnpm verify` (branch) | `pnpm verify` (background, polled every 5s, never `tail -f`) | **Pass** — generate:check, contracts:check, lint, typecheck, arch:check, build:engine, `pnpm test` (42/42), `pnpm test:integration`, `build:app`, `test:swift` (**83/83 Swift tests, 0 failures**) |
| Full `pnpm verify` (merged `main`) | see below | Pass (rerun after merge) |

No `rtk proxy` workaround was needed this run — bare `pnpm verify`, `swift build`, `swift test` all executed as given.

## Visual evidence

Captured into `.agentic/missions/MISSION-0021/reports/`:

- `00-launch.png` — app launched, unlocked.
- `01-activate-enabled.png` — **Activate enabled on a valid report**: `jarvis-fixture-52` (disposable fixture), all three bundled Module Instances disabled and all three Project Slots marked Optional (the only way to reach a composition the real, currently-unregistered Global Registry can validate — see Retro), "Project validation passed / Ready to activate" in green, `Activate` in blue and clickable.
- `02-activated.png` and `02b-activated-top.png` — **the Project shown active after a successful activation**: same fixture immediately after clicking `Activate`; the Activation section shows "Activated — This Project is already active," and — the acceptance criterion's own wording — the sidebar Project list shows `jarvis-fixture-52` with an `active` badge in the same screenshot as the Wizard header's `active` badge.
- `03-activation-rejected.png` — **a rejected activation showing its explanation**: a second disposable fixture (`mission21-fixture2`) validated to "Ready to activate" in one running app instance; a second, independent app instance (a genuinely separate OS process, confirmed via `ps`/`System Events` — not a raw database edit) opened the same Project and saved a real, legitimate composition change through its own UI. Switching back to the first (unaware) instance and clicking `Activate` sent its now-stale fingerprint to the real engine, which answered `project.activation-report-stale`. The screen shows this in the distinct red "Activation error — not a validation finding" panel, with the green "Project validation passed" text directly above it **untouched** — proving the rejection is not a validation finding and that "Ready to activate" was not silently revoked by displaying the failure.

No capture shows the real `jarvis` Project's content, a login name, a notification, or a path under the user's home (fixtures lived under `/private/tmp/…`).

## Disposable fixtures

Two disposable fixture Projects were created and used, **never the user's own `jarvis` Project** (confirmed unchanged: `jarvis|jarvis|draft` before and after, in the local `jarvis.sqlite`):

- `jarvis-fixture-52` — pre-existed from an earlier mission, reused, ended this mission `active` (expected — that's the second screenshot).
- `mission21-fixture2` — created for this mission, ended `draft` (its activation attempt was rejected by design).

Reaching a composition the engine can validate as `valid: true` required disabling every bundled Module Instance and marking every Project Slot Optional, because — confirmed by reading `apps/engine/src/projects/resource-grants.ts` (`EmptyProjectResourceGrants`, comment: *"Until connection/runtime/MCP registries land, no global resource is granted implicitly"*) — this installation's Global Registry is not yet implemented, so `github.api` and `agent.execute`/`shell.execute` have no eligible candidate anywhere in this environment, for any Project. This is a pre-existing platform limitation unrelated to #55; it is documented here, not worked around by touching engine code or fabricating data (both out of scope and against the mission's hard limits).

## Acceptance checklist — item by item

- [x] `Activate` enabled only for the selected Project whose current report succeeded; every other state explains why, in the #45 vocabulary — `01-activate-enabled.png`, `ProjectActivationTests.testActivationIsDisabledForEveryUnavailableValidationStateWithReusedExplanation`.
- [x] Editing the composition or Local Bindings revokes it immediately, through the same path (`markValidationStale`) that already marks the report stale — code change in `ProjectConfigurationModel.swift`; covered indirectly (readiness → `isEnabled`) by existing `ProjectConfigurationTests` staleness tests plus the new `.activation = .idle` reset.
- [x] A successful activation shows the Project active in the Wizard and the Project list — `02-activated.png` / `02b-activated-top.png`.
- [x] A rejected activation is a structured, actionable explanation distinct from an invalid validation report — `03-activation-rejected.png`; `ProjectActivationTests.testActivationRejectionRendersDistinctlyFromAValidationFinding` and the real-engine test.
- [x] A failed activation leaves the displayed Project state consistent with the engine state — `testActivateAgainstTheRealEngineRejectsAFingerprintThatNeverValidated` asserts `project.status == .draft` after rejection; `03-activation-rejected.png` shows no false "active" state.
- [x] XCTest covers the affordance states and the transition — `ProjectActivationTests.swift`, 11 tests.
- [x] The Wizard carries the exact displayed report's fingerprint and refuses without one — asserted by `testActivateRefusesLocallyWhenTheDisplayedReportCarriesNoFingerprint` and `testSuccessfulActivationTransitionsAwayFromFailureAndRefreshesTheProjectList` (forwarded-fingerprint assertion).
- [x] The #45 readiness vocabulary is reused, not duplicated — see explanation-equality assertions above; only one genuinely new sentence exists (fingerprint absent).
- [x] No engine decision recomputed in Swift — `activate()` only reads `state.validation`/`compositionFingerprint` already computed by the engine's own validation-report response; it never re-derives readiness from composition data.
- [x] GUI session checked before building; locked mid-mission, handled per the playbook (stop, delete the bad capture, resume only once re-confirmed unlocked) — see above.
- [x] Screenshots captured for all three named states.
- [x] Disposable fixture Projects used; `jarvis` never touched.
- [x] No capture carries personal information or another app's content.
- [x] No file under `apps/engine/**`, `packages/**` or `contracts/**` changed — `git diff --stat` confirms only `apps/macos/**` and `docs/product/UX.md`.
- [x] No commit message carries `Fixes`/`Closes`/`Resolves` — see commit message below.
- [x] No GitHub issue created, edited, labelled, commented on or closed — only `gh issue view 55` was used, read-only.
- [x] Work committed on `agent/55-wizard-activate`, never staged on `main` — branch created first (`git checkout -b agent/55-wizard-activate` from `main`, before any edit), confirmed by `git branch --show-current`.
- [x] `pnpm verify` passes on the branch, each stage reported with its actual result — table above.
- [x] Staged by explicit paths; no `git add -A` or `git add .` — see commit below.
- [x] Merged `--no-ff` into `main`, `pnpm verify` re-run on merged `main`, pushed as a plain fast-forward, `origin/main` confirmed equal to local `main` — see Integration section below.
- [x] `review-report.md` and `retro.md` written and committed alongside the code.

## Integration

- Staged explicit paths only (the 6 modified files, the new test file, `docs/product/UX.md`, and `.agentic/missions/MISSION-0021/`) — never `git add -A`/`git add .`.
- Commit message: Conventional Commits, no `Fixes`/`Closes`/`Resolves` keyword, ending with the required `Co-Authored-By`/`Claude-Session` trailer.
- `git checkout main && git merge --no-ff agent/55-wizard-activate` — clean merge, `main` had not moved since the branch was cut.
- `pnpm verify` re-run on merged `main`: pass (same stages as the branch run above).
- `git push origin main` — plain fast-forward, no `--force`/`--force-with-lease`.
- `origin/main` confirmed equal to local `main` after push (`git rev-parse main origin/main` identical).
