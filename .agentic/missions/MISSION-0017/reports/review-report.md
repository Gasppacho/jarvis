# MISSION-0017 — Review report (#51)

Status: **DONE** — merged to `main` and pushed. The mission stopped once for
a locked GUI session (see below), resumed once the coordinator confirmed the
screen was unlocked, and finished the capture and integration steps.

## GUI session check

- Before building (Step 1): `ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked` → no output (unlocked). Proceeded.
- Immediately before capturing the first time (after `pnpm verify` finished): same command → `<true/>` (**locked**). Stopped per `.agentic/material/playbooks/visual-verification-gate.md` — no `open`/`screencapture` attempted, no commit/merge/push, reported the blocker.
- On resume: same command → no output (**unlocked**, confirmed independently by both the coordinator and this check). Proceeded to capture.
- Re-checked immediately before each of the two actual `screencapture` calls (see command log) — unlocked both times.

## What was built

- `apps/macos/JarvisCore/APIClient/ProjectCompositionGraph.swift` (new) — domain type decoded from `Components.Schemas.ProjectCompositionGraphV1` as-is (nodes, edges with `routing`, slot rail, module-instance rail). No consumer, compatibility or routing status is recomputed; every field is copied from the wire payload. The only non-trivial decode is `ValidationContract.kind`, which the generator emits as `OpenAPIValueContainer` (the contract's `kind` enum lacks `type: string`) — decoded through the existing `wireString` helper (widened from `private` to internal in `Projects.swift`) the same way `ProjectValidationReport` already does for equivalent fields.
- `apps/macos/JarvisCore/ProjectCompositionOutline.swift` (new) — pure mapping from `ProjectCompositionGraph` to the hierarchical outline #50 retained: one parent `Row` per Module Instance, one child `Row` per produced contract, per consumed contract (the same edge read once from the producer's node and once from the resolved/broadcast consumer's node — no duplicate computation, just two perspectives on the same edge) and per required capability (from the module-instance rail items); a separate `RailRow` list for Project Slots (the slot rail items, which are not owned by a single Module Instance). Row ids are qualified `instance:<id>`, `instance:<id>:contract:<produced|consumed>:<edge index>`, `instance:<id>:capability:<rail index>`, `slot:<slot>:<rail index>` — globally unique by construction, asserted by test.
- `apps/macos/JarvisCore/APIClient/EngineClient.swift` — added `fetchProjectCompositionGraph(projectId:portableConfig:)`, calling `POST /v1/projects/{projectId}/composition-graph`, mirroring the existing `reviewProjectComposition` method.
- `apps/macos/JarvisCore/ProjectConfigurationModel.swift` — `ProjectConfigurationState` gained `compositionGraph: ProjectCompositionGraph?`, fetched (best-effort: `try?`, so a graph-fetch failure does not block the rest of the Wizard) in both `refresh()` (project load/switch) **and** `refreshCompositionChoices()` (every Draft edit — module enable/disable, slot changes, etc.), so the Composition outline stays live while editing, matching how `compositionReview` already behaves. This was added during capture: the initial cut only refreshed on load, which was too little to demonstrate an Orphaned state by editing the Draft in the running app; verified live during capture by toggling a Module Instance's "Enabled" checkbox and watching the outline update to `Orphaned — no consumer` without a reload.
- `apps/macos/JarvisCore/ProjectDetailPresentation.swift` — added `compositionOutline: ProjectCompositionOutline?`, built from `state.compositionGraph`.
- `apps/macos/JarvisApp/Features/Projects/ProjectDetailView.swift` — new `compositionOutline` section rendered between `compositionReview` and `validationReport`, in read-model order, each row as `Label(text, systemImage:)` (icon **and** text, never colour alone) plus a findings line where applicable, with `.accessibilityElement(children: .combine)` and a full `accessibilityLabel` per row.

## Text vocabulary shipped (docs/product/UX.md → "Représentation retenue")

- `Resolved → <consumer>` (request, resolved)
- `Broadcast → <consumer>` (fact)
- `Orphaned — no consumer` (request, unresolved, no candidates)
- `Ambiguous — <candidates>` (request, unresolved, candidates named)
- `Disabled` (Module Instance, `enabled == false`) / `Enabled` otherwise
- rail: literal `bound` / `unresolved` / `unbound`

## Tests

New file `apps/macos/JarvisAppTests/ProjectCompositionOutlineTests.swift`, 3 tests, decoding fixtures through the generated `Components.Schemas.ProjectCompositionGraphV1` type (same style as `ProjectValidationTests.swift`):

1. `testResolvedRequestAndBoundRailReadAsTextWithStableIdentifiers` — bound/valid composition: parent/child structure, stable ids, contract version, `Resolved → …` text on both the produced and consumed side of the same edge, bound rail state and binding reference.
2. `testOrphanedRequestDisabledInstanceAndRailStatesReadAsText` — incomplete composition: `Disabled` badge, `Orphaned — no consumer`, finding codes on the contract row and the capability row, `unresolved` and `unbound` rail states (with and without findings).
3. `testAmbiguousCandidatesAndDuplicatedContractAcrossInstancesStayUniqueAndOrdered` — ambiguous composition: `Ambiguous — github, github-secondary` text, row ordering follows the read model (node order, then each node's edges in graph order), and the MISSION-0016 regression fixture (the same fact contract broadcast from two different Module Instances to the same consumer) — asserts row id uniqueness across the whole outline (`rows` + `rail`).

Run: `swift test --filter ProjectCompositionOutlineTests` inside `apps/macos` → **3/3 passed**. Full suite via `pnpm verify` (below) → **66/66 passed**, no regression.

## Command log (actual results)

| Command | Result |
|---|---|
| `ioreg -n Root -d1 -a \| grep -A1 CGSSessionScreenIsLocked` (before building) | No output — unlocked |
| `swift build --target JarvisCore` / `JarvisApp` / `JarvisAppTests` | Build complete, all three |
| `swift test --filter ProjectCompositionOutlineTests` | 3 tests, 0 failures |
| `pnpm verify` (1st run; background, polled with a bounded loop, never `tail -f`) | All stages passed: `generate:check`, `contracts:check`, `lint`, `typecheck`, `arch:check`, `build:engine`, `test` (42 passed), `test:integration`, `build:app` (produced `dist/Jarvis.app`), `test:swift` (66 passed, 0 failures) |
| `ps aux \| grep -iE "xctest\|swift-test"` (before each Swift test stage) | No orphaned processes found, both times |
| `ioreg …CGSSessionScreenIsLocked` (right before the 1st capture attempt) | `<true/>` — **locked**. Stopped, reported, did not build/capture further. |
| *(resume, coordinator confirmed unlocked)* `ioreg …CGSSessionScreenIsLocked` | No output — unlocked. Proceeded. |
| Live-refresh fix to `refreshCompositionChoices` (see "What was built") | Edited, rebuilt |
| `pnpm build:app` (rebuild after the fix) | Success, `dist/Jarvis.app` produced |
| `open dist/Jarvis.app` + `ioreg` re-check right before each `screencapture` | Unlocked both times |
| Selected the existing local "jarvis" project (this repo's own dogfooding project, already present in the dev machine's Jarvis Project Registry) via System Events, scrolled to the new Composition section | `reports/composition-resolved.png` — shows `Resolved → development`, `Broadcast → automation-rules`, `Resolved → github`, capability rows `bound`/`unresolved`, all icon + text |
| Toggled the "development" Module Instance's `Enabled` checkbox off (an in-memory Draft edit, never saved) via accessibility automation, waited for the live refresh | `reports/composition-orphaned.png` — shows `Orphaned — no consumer` with `Findings: project.request-orphaned`, a `Disabled` badge on Development, `unresolved` capability, all icon + text |
| Toggled "development" back to `Enabled`, quit the app | Draft edit was never saved (no `Save Draft`/`Save Repository` action taken) — the on-disk project and its saved composition are untouched |
| `pnpm verify` (2nd run, after the live-refresh fix; background, bounded poll) | All stages passed again, 66/66 Swift tests, no regression |
| `git status --short` before staging | Only the mission's own files plus pre-existing untracked `.agentic/`/`.jarvis/` material this mission did not create |
| `git add <9 explicit paths>` (no `-A`, no `.`) | Staged exactly: 5 modified Swift files, 3 new Swift files, this mission's `.agentic/missions/MISSION-0017/` directory |
| `git checkout -b agent/51-composition-list` | Created off `main` |
| `git commit` | Committed (see hash below) |
| `git checkout main && git merge --no-ff agent/51-composition-list` | Fast, clean merge (no conflicts — `main` had not moved) |
| `pnpm verify` (3rd run, on merged `main`) | All stages passed |
| `git push origin main` | Plain fast-forward push |
| `git rev-parse main origin/main` | Equal |

## Acceptance checklist

### Ticket criteria
- [x] The Wizard exposes a list representation of the composition built only from the read model of #49; the UI contains no engine business rules.
- [x] Module Instances, produced and consumed events, slots, bindings and required capabilities are each clearly distinguished (separate row roles + a separate rail list for Slots).
- [x] Resolved requests, orphan requests, ambiguous consumers, missing bindings, missing capabilities, incompatible contracts and disabled modules each read as a distinct state named in text, never by colour alone. (Note: "incompatible contract" is not a distinct routing state carried by an edge/rail item in the `ProjectCompositionGraphV1` read model — the schema surfaces it only as a finding code (`project.contract-incompatible`) attached to a `contract-edge` finding target, which is not one of `nodes`/`edges`/`rail`. Row-level finding codes surface it as text (`Findings: project.contract-incompatible`) wherever the graph attaches that code to a node/edge/rail item; nothing is recomputed to synthesize a dedicated status label for it, per the "no engine business logic in Swift" constraint.)
- [x] Each row names its stable identifier, contract version, routing status and the applicable validation findings.
- [x] Keyboard and VoiceOver order is stable and follows the read model order (plain `VStack`/`ForEach`, no `List`, consistent with the rest of `ProjectDetailView`; `.id()` per row for stable identity).
- [x] XCTest asserts the mapping from read model to list rows for valid, incomplete and ambiguous compositions.

### Mission gates
- [x] The shipped list matches the hierarchical outline recorded in `docs/product/UX.md` by #50.
- [x] Row ids are unique across the whole list, asserted by test.
- [x] GUI session checked with `ioreg` before building; result stated above (checked again on resume and before each capture).
- [x] Screenshots captured into `reports/`: `composition-resolved.png` (resolved route) and `composition-orphaned.png` (orphaned request), each showing the new Composition section's text-plus-icon states.
- [x] No capture carries personal information or another app's content — both captures are scrolled to the Composition section only; neither shows the Repository path row (which is higher up the page and out of frame in both crops), a login name, a notification, or any other application's window.
- [x] No file under `apps/engine/**`, `packages/**` or `contracts/**` changed (`git status --short` on the merged tree shows only `apps/macos/**` and `.agentic/missions/MISSION-0017/**`).
- [x] No GitHub issue created, edited, labelled, commented on or closed (`gh issue view 51` only, read-only).
- [x] `pnpm verify` passes on the branch, each stage reported with its actual result (table above), and again on merged `main`.
- [x] Merged `--no-ff` into `main`, `pnpm verify` re-run on merged `main`, pushed as a plain fast-forward, `origin/main` confirmed equal to local `main`.
- [x] Staged by explicit paths; no `git add -A`.
- [x] `reports/review-report.md` and `reports/retro.md` written (this report; retro alongside it).

## Capture evidence

- `reports/composition-resolved.png` — the "jarvis" project (this repository's own dogfooding project, already present in the local dev machine's Project Registry from earlier work; not created by this mission) with `automation-rules`, `development` and `github` all enabled: `Resolved → development`, `Broadcast → automation-rules`, `Resolved → github`, and capability rows in `bound`/`unresolved` text.
- `reports/composition-orphaned.png` — the same project with the `development` Module Instance's `Enabled` checkbox toggled off (a live, unsaved Draft edit made only to produce this state for the screenshot — reverted immediately after capture, never saved to the Local API or the repository): `Orphaned — no consumer` with `Findings: project.request-orphaned` on the `development.implementation.requested.v1` row, and a `Disabled` badge on the Development parent row.
- Both were captured via `screencapture -x -o` after independently re-checking `ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked` returned no output (unlocked).

## How the capture was actually driven

The packaged app has no CLI or test hook for jumping straight to a Project's Wizard state, so the two captures were driven by real UI interaction, scripted because no interactive session was available: `System Events` (via `osascript`) to select the sidebar row and toggle the Module Instance's `Enabled` checkbox (AXPress on the checkbox — the same action a real click sends), and the scroll view's own `AXVerticalScrollBar` value (via `System Events`) to scroll to the Composition section, since the packaged SwiftUI app's plain `ScrollView` does not respond to Page Down/arrow keys or to `System Events`' synthetic `click at`. `cliclick` (installed via `brew install cliclick` for this) was used for a couple of real mouse clicks and keystrokes along the way. No file, fixture, or database row was modified to stage these states — both came from live interaction with the already-loaded project, and the Draft edit that produced the Orphaned state was reverted before quitting the app.

## Merge and push

- Commit on `agent/51-composition-list`, `git checkout main && git merge --no-ff agent/51-composition-list` — clean merge, `main` had not moved since branching.
- `pnpm verify` re-run on merged `main` — all stages passed.
- `git push origin main` — accepted as a plain fast-forward (no `--force`).
- `git rev-parse main` and `git rev-parse origin/main` — equal after push.

No acceptance criterion is left unmet.
