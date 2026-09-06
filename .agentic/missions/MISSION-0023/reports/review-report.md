# MISSION-0023 — Review report (#48)

## GUI session check

- Before building anything (session start): `ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked` → no output → unlocked.
- Mid-mission, before the app-build/capture step: `<true/>` → **locked**. `pnpm build:app`, `open dist/Jarvis.app` and `screencapture` were held back while locked; only headless steps (`pnpm generate`, `pnpm typecheck`, `pnpm lint`, `pnpm contracts:check`, `pnpm arch:check`, `pnpm build:engine`, engine `vitest`, `swift build`, `swift test`) ran during that window, since none of them open a window or touch the screen.
- The coordinator confirmed the session unlocked and instructed resuming; re-checked independently before proceeding: `ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked` → no output → unlocked. Re-checked again immediately before each capture batch; stayed unlocked throughout the capture sequence.
- `pnpm build:app` ran, `dist/Jarvis.app` was launched, and the three named states were captured (see Screenshots below).

## Fixture Project used

A disposable fixture repository was created at a scratch path (`.../scratchpad/fixture-project-0023`, a fresh `git init` with one commit and a fake `origin` remote), imported into Jarvis as project `fixture-project-0023`, given a `Development` Module Instance, a Module Binding, and a Project Slot. The user's own `jarvis` Project was never opened or modified — the sidebar screenshots below show it present but unselected, alongside two pre-existing disposable fixtures from earlier missions (`jarvis-fixture-52`, `mission21-fixture2`) that were also left untouched.

One earlier capture (`03-toolbar-btn1.png`, not committed) showed the real macOS file-open panel defaulting to the user's `~/Documents` folder, which listed personal file names in its "Previous 30 Days" section. It was deleted immediately upon review, before being used for anything, and is disclosed here per the mission's personal-information rule. No committed screenshot shows it.

## Consumer inventory for the `requires` migration

`ModulePackage.requires` was `string[]` on the wire while `packages/modules/*/module.manifest.yaml` already declared `{id, binding}`. Every consumer found and moved together, in one change:

| Consumer | File | Change |
|---|---|---|
| Kernel catalog flattening | `packages/kernel/src/module-host.ts` | `ModuleCatalogEntry.requires` is now `readonly ModuleCatalogCapabilityRequirement[]` (`{id, binding?}`); `toCatalogEntry` maps `{id, binding}` instead of `.map(c => c.id)`. |
| Project Runtime catalog projection | `packages/project-runtime/src/project-types.ts` | `ProjectCompositionModulePackage.requires` same `{id, binding?}[]` shape (new `ProjectModuleCatalogCapabilityRequirement`). |
| Composition-choices module-instance projection | `packages/project-runtime/src/composition-choices.ts` | `requiredCapabilities` (a *different*, pre-existing capability-id-only field used for eligibility) now derived with `.map(r => r.id)` since its source changed shape; the field itself stays `string[]` — out of this ticket's scope. |
| OpenAPI contract | `contracts/openapi/local-api.v1.yaml` | `ModulePackage.requires` items now `$ref: ModuleCapabilityRequirementV1` (`{id, binding?}`). New `ModuleCapabilityRequirementV1`, `CapabilityCatalogEntryV1`, `CapabilityCatalogV1` schemas; new `GET /v1/capability-catalog` path. |
| JSON Schema (module manifest) | `contracts/schemas/module-manifest.v1.schema.json` | Already modeled `{id, binding}` with a conditional `binding` requirement for `project-repository` resolution — no change needed; confirms the manifests were already correct and only the wire contract lagged. |
| Generated TypeScript client | `apps/engine/src/api/generated/local-api.ts` | Regenerated via `pnpm generate` (openapi-typescript) — never hand-edited. |
| Generated Swift client (`JarvisAPI`) | build-time Swift OpenAPI Generator output | Not hand-edited; regenerates from the same `contracts/openapi/local-api.v1.yaml` at `swift build` time (`apps/macos/JarvisAPI/JarvisAPI.swift` is a stub explaining this). Confirmed via `swift build` that `Components.Schemas.ModuleCapabilityRequirementV1` now exists and is consumed. |
| Hand-written Swift domain wrapper | `apps/macos/JarvisCore/APIClient/Modules.swift` | New `ModuleCapabilityRequirement` struct; `ModulePackage.requires: [ModuleCapabilityRequirement]`; added `requiredCapabilityIDs` and `declaredBindingNames` computed properties; `presentationFields` uses `requiredCapabilityIDs`. |
| Swift presentation model | `apps/macos/JarvisCore/ProjectDetailPresentation.swift` | `package?.requires` (old string-array fallback) → `package?.requiredCapabilityIDs`; `capabilityOptions` derived from `requiredCapabilityIDs`; new `ModuleCard.declaredBindingNames` and `capabilityGuidance: [String: String]`. |
| Swift view (guided controls) | `apps/macos/JarvisApp/Features/Projects/ProjectDetailView.swift` | `capabilityControl` shows served guidance caption; new `bindingNameControl` offers `declaredBindingNames` for the selected package with an `Advanced` custom-name path. |
| Hand-written Swift fixtures decoding `requires` | `apps/macos/JarvisAppTests/ModuleCatalogTests.swift`, `apps/macos/JarvisAppTests/ProjectResourceGuidanceTests.swift` | Updated to the `{id, binding}` shape; `ProjectConfigurationTests.swift` and `AutomationRuleConfigurationTests.swift` fixtures used `"requires": []` (empty), which decodes unchanged under either shape — no edit needed there. |
| Engine Application Harness tests | `apps/engine/test/module-catalog.integration.test.ts`, `apps/engine/test/composition-choices.integration.test.ts` | Wire expectations updated to `{id, binding}` objects; validated against the OpenAPI `ModulePackage` schema via `localApiValidator`. |
| Unrelated `requires` usages left alone (confirmed by inspection, not touched) | `contracts/schemas/project-config.v1.schema.json` (`slots.<id>.requires`, a single capability-id string a Project Slot needs — different concept), `packages/project-runtime/src/composition-validator.ts` / `composition-graph.ts` (`ProjectModuleCapabilityRequirement` / `.composition(...).requires`, already the rich per-manifest shape, never flattened), `ProjectResourceBindingChoice.requiredCapabilities` (Slot eligibility capability-id list, unrelated field) | No change — verified these are semantically distinct from `ModulePackage.requires`. |

The in-place migration completed in one coordinated, green change — no dual-field fallback was needed.

## Served capability vocabulary

- New machine-readable source: `packages/kernel/src/capability-catalog.ts` (`capabilityCatalog()`), reproducing `docs/contracts/CAPABILITY_CATALOG_V1.md` verbatim (14 capability ids; `owner` is `null` where the document's table has no owner column — no vocabulary invented).
- Served at `GET /v1/capability-catalog` (`apps/engine/src/http/server.ts`), contract `CapabilityCatalogV1` in `contracts/openapi/local-api.v1.yaml`.
- `docs/contracts/CAPABILITY_CATALOG_V1.md` updated with a "Served source" section stating it now documents the served contract rather than being read directly by clients.
- `docs/product/UX.md` updated (the capability-control and module-binding paragraphs) to describe the served-guidance caption and the binding-name picker.
- Swift: `CapabilityGuidance` model + `EngineClient.getCapabilityCatalog()` + `ModuleCatalogModel.capabilityGuidance`, wired into `ProjectDetailPresentation.capabilityGuidance: [String: String]` and rendered in `capabilityControl`. An id absent from the map renders `"Unavailable"` (never guessed).

## Guided controls (Swift)

- Binding names: `ModulePackage.declaredBindingNames` (dedup, sorted `requires[].binding`) → `ModuleCard.declaredBindingNames` → `bindingNameControl` Picker in `ProjectDetailView.swift`, with an `Advanced` `TextField` for a custom binding name (mirrors the existing `capabilityControl` pattern).
- Capability IDs: `capabilityOptions` (union of every loaded package's `requiredCapabilityIDs`) — unchanged behavior, now correctly derived from the migrated shape.
- Served guidance: capability control shows `presentation.capabilityGuidance[currentValue] ?? "Unavailable"` beneath the picker.
- `Advanced` custom-value path: preserved for both the capability picker (pre-existing) and the new binding-name picker (added).

## Anti-hardcoding grep

```
rtk proxy grep -rnE "\"(repository\.(read|write)|git\.(branch|commit|push)|shell\.execute|artifact\.(read|write)|agent\.execute|mcp\.invoke|work-items\.read|scm\.change-request\.(manage|review|merge)|github\.api)\"" apps/macos/JarvisCore apps/macos/JarvisApp --include="*.swift"
→ no matches (exit 1)

rtk proxy grep -rnE "\"(repository|agentRuntime|sourceControl|tickets)\"" apps/macos/JarvisCore apps/macos/JarvisApp --include="*.swift"
→ no matches (exit 1)

rtk proxy grep -rn "Modify files inside the leased workspace\|Start a session on the bound Agent Runtime\|Create a commit owned by the execution" apps/macos/JarvisCore apps/macos/JarvisApp --include="*.swift"
→ no matches (exit 1)
```

No capability ID, manifest binding name, or catalog prose string is hardcoded in `JarvisCore`/`JarvisApp` production Swift, including as a fallback. (Test fixture files intentionally construct these values as JSON test data — that is fixture data, not shell vocabulary, and is unaffected by this grep since it targets `JarvisCore`/`JarvisApp` only.)

## Commands run (actual results)

Individual commands run first, while iterating (before the branch existed as a coherent commit-ready set):

| Command | Result |
|---|---|
| `pnpm generate` | OK — regenerated `apps/engine/src/api/generated/local-api.ts` |
| `pnpm typecheck` | OK — no errors |
| `pnpm contracts:check` | OK — `contracts ok — 15 schemas, 4 event examples, 4 manifests, 32 API paths` |
| `pnpm lint` (prettier) | Failed once on `packages/kernel/src/capability-catalog.ts` (1 file, unformatted); fixed with `prettier --write`; re-run OK |
| `pnpm arch:check` | OK — `no dependency violations found (68 modules, 207 dependencies cruised)` |
| `pnpm build:engine` | OK |
| `vitest run --project unit --project integration` | OK — 217 tests passed (17 files), including the new capability-catalog Application Harness test and the updated `{id, binding}` wire assertions |
| `swift build --package-path apps/macos` | OK — `Build complete!` |
| `swift test --package-path apps/macos` | OK — 83 tests passed (0 failures), including updated `ModuleCatalogTests` and `ProjectResourceGuidanceTests` |
| `pnpm build:app` | OK — `dist/Jarvis.app` built (debug Swift build) after the screen unlocked |

### Full `pnpm verify` on the branch — two runs, both real, logged in full

**Run 1** (working tree edited but nothing staged yet) — failed, exactly one stage, for an expected reason:

| Stage | Result |
|---|---|
| `generate:check` | **Failed.** `pnpm generate` reproduced the contract correctly, but `git diff --exit-code` then diffed the regenerated `apps/engine/src/api/generated/local-api.ts` against the **index**, which still held the pre-mission committed content (nothing had been `git add`ed yet). This is expected behavior of that check on a dirty, unstaged tree — not a code defect. |
| Everything after `generate:check` | Not reached — `&&`-chained script stopped at the first failure. |

Fix: staged the mission's explicit files (`git add <paths>` — see the git log below), which makes the working tree match the index for the generated file.

**Run 2** (after staging) — every stage green:

| Stage | Result |
|---|---|
| `generate:check` | OK — no diff once staged |
| `contracts:check` | OK — `contracts ok — 15 schemas, 4 event examples, 4 manifests, 32 API paths` |
| `lint` (prettier) | OK — `All matched files use Prettier code style!` |
| `typecheck` | OK — no errors |
| `arch:check` | OK — `no dependency violations found (68 modules, 207 dependencies cruised)` |
| `build:engine` | OK — bundled into `dist/engine` |
| `test` (unit) | OK — part of the 217-test combined run above |
| `test:integration` | OK — part of the 217-test combined run above |
| `build:app` | OK — `dist/Jarvis.app` assembled |
| `test:swift` | OK — `Test Suite 'All tests' passed … Executed 83 tests, with 0 failures` |

Full log: `verify-branch2.log` (run 2, exit 0) and `verify-branch.log` (run 1, exit 1 at `generate:check` only) in the session scratchpad.

### A note on scratchpad log attribution

The session scratchpad (`.../scratchpad/`) is shared across this multi-day mission campaign, not private to MISSION-0023 — it holds logs from Sept 4–6 across many prior missions. Two files there, `verify-branch-2.log` and `verify-branch-3.log`, are **not** from this mission: they were written 2026-09-06 14:33–14:39, over 40 minutes before MISSION-0023's own work began, and their content matches **MISSION-0022** exactly — the prettier failure in `verify-branch-2.log` names `apps/engine/src/projects/service.test.ts` and `apps/engine/src/projects/service.ts` (2 files neither read nor touched by this mission), `contracts-check` in that log reports **31** API paths (this mission's own change is what makes it 32), and their timestamps sit just before commit `fbb1b973` ("docs(agentic): finalize mission 0022 review report", 2026-09-06 14:39:12), which is `HEAD~1` on `main` at the point this mission branched. This mission's own two `pnpm verify` runs are `verify-branch.log` and `verify-branch2.log`, both named and described above; the only prettier failure this mission actually produced was the single-file `capability-catalog.ts` one already listed in the individual-commands table.

## Screenshots

Captured into this directory, using the disposable `fixture-project-0023` fixture Project:

- `capability-control-served-guidance.png` — the Project Slot's "Required capability" control set to `repository.write`, showing the served guidance caption "Modify files inside the leased workspace" (from `GET /v1/capability-catalog`) directly beneath the picker.
- `binding-name-offered-from-package.png` — the "Development" Module Instance's Module Binding name picker open, offering `agentRuntime`, `repository`, `tickets` — exactly the binding names `packages/modules/development/module.manifest.yaml` declares under `capabilities.requires[].binding` — never a shell-invented list.
- `advanced-custom-value-path.png` — both `Advanced` disclosures expanded at once: the capability control's `Advanced` showing a `repository.write` custom-value text field, and the binding-name control's `Advanced` showing a `repository` custom-value text field, alongside the same served-guidance caption.

Each was reviewed full-resolution before being kept; none shows personal information, the user's own `jarvis` Project's content, or any other application.

## Integration result

- Commit on branch: `820d158` "feat(contracts): serve capability vocabulary and module binding names" — no `Fixes`/`Closes`/`Resolves` keyword; includes this mission's `.agentic/missions/MISSION-0023/reports/` alongside the code (23 files changed).
- `main` before merge: `fbb1b973` (verified equal to `origin/main` before merging — confirms `main` had not moved since the branch was cut).
- Merge: `git checkout main && git merge --no-ff agent/48-configuration-vocabulary` → merge commit `8d16001`.
- Re-verify on merged `main`: full `pnpm verify`, exit 0 — every stage green (`generate:check`, `contracts:check`, `lint`, `typecheck`, `arch:check`, `build:engine`, `test`, `test:integration`, `build:app`, `test:swift`; Swift: `Executed 83 tests, with 0 failures`). Log: `verify-merged-main.log`.
- Push: `git push origin main` → `fbb1b97..8d16001 main -> main`, a plain fast-forward (no `--force`).
- Confirmed equal: `git rev-parse main origin/main` → both `8d16001cc9b8482f71bfc2e4b9afa3dbce1860cc`.

## Left on disk (scratchpad — not part of the repo)

Per instruction, disclosing what this mission leaves behind in the session scratchpad so it can be deleted if unwanted:

- `.../scratchpad/fixture-project-0023/` — the disposable fixture git repository used for the capture step. Registered inside the packaged Jarvis app's local project database as project `fixture-project-0023` (draft, never activated). Safe to delete the directory; the app will simply report that Project's repository as unreachable on next launch, same as any other project whose folder moved.
- Numerous intermediate screenshots and verify/build logs from this mission's own work (`00-initial.png` through `26-capability-advanced2.png`, `build-app.log`, `swift-build.log`, `swift-test.log`, `verify-branch.log`, `verify-branch2.log`, `verify-merged-main.log`, `vitest-full.log`) — superseded by the three named captures and this report; safe to delete.
- The scratchpad also still holds unrelated logs and captures from prior missions (Sept 4–6, e.g. `verify-branch-2.log`, `verify-branch-3.log`, `test-swift-*.log`) predating this mission — see the attribution note above; left untouched as out of this mission's scope.

Nothing was written outside the session scratchpad and the repository itself.

## Acceptance checklist — item by item

### Ticket criteria
- [x] The versioned Module Catalog contract carries a requirement's capability `id` and manifest `binding` name together. — `ModuleCapabilityRequirementV1` in the OpenAPI contract; engine and Swift both migrated.
- [x] A served, versioned contract source supplies human-readable capability meaning; no client copies prose from `docs/contracts/CAPABILITY_CATALOG_V1.md`. — `GET /v1/capability-catalog` / `CapabilityCatalogV1`.
- [x] Bundled manifests, Engine catalog output, Local API, generated Swift client, examples and compatibility tests migrate together. — manifests were already correct; every other consumer moved in this change; no example payloads carried the old flattened shape.
- [x] The Project configuration UI offers binding names declared by the selected Module Package and capability IDs reported by the live catalog. — `bindingNameControl` / `capabilityControl`.
- [x] Capability controls display served human guidance and retain an explicit `Advanced` custom-value path. — done for both the capability and binding-name controls.
- [x] Unknown or unavailable catalog vocabulary is shown as unavailable rather than guessed. — `capabilityGuidance[id] ?? "Unavailable"`.
- [x] Application Harness tests prove catalog wire values, and presentation-model XCTest proves offered controls and the Advanced fallback. — see test sections above.

### Mission gates
- [x] No capability ID, binding name or catalog prose hardcoded in Swift, including as a fallback — grep above.
- [x] Every consumer of `requires` migrated in the same change; no half-migrated contract left behind.
- [x] No generated file hand-edited; `pnpm generate:check` passes. — not hand-edited; passed once staged (run 2 above).
- [x] GUI session checked with `ioreg` before building; result stated above.
- [x] Screenshots captured into `reports/` — `capability-control-served-guidance.png`, `binding-name-offered-from-package.png`, `advanced-custom-value-path.png`.
- [x] A disposable fixture Project was used — `fixture-project-0023`, a fresh scratch git repo; the user's own `jarvis` Project was never opened or modified.
- [x] No capture carries personal information or another app's content — one draft capture that did (a file-open panel defaulting to `~/Documents`) was deleted before use and is disclosed above; none of the three kept captures shows anything but the Jarvis app on the disposable fixture.
- [x] No commit message carries a `Fixes`/`Closes`/`Resolves` keyword — confirmed below.
- [x] No GitHub issue created, edited, labelled, commented on or closed.
- [x] The work was committed on `agent/48-configuration-vocabulary`, never staged on `main`. — branch created before any commit (see retro.md for a process note: the working tree was first assembled on `main` and only checked out onto the feature branch afterward, before staging/committing anything).
- [x] `pnpm verify` passes on the branch — run 2 above, exit 0.
- [x] Staged by explicit paths; no `git add -A` — see git log below.
- [x] Merged `--no-ff` into `main`, `pnpm verify` re-run on merged `main`, pushed as a plain fast-forward, `origin/main` confirmed equal to local `main` — see Integration result below.
- [x] `reports/review-report.md` and `reports/retro.md` written (this file, and `retro.md`); will be committed alongside the code.
