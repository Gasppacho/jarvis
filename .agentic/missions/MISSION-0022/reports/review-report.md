# MISSION-0022 — Review report (#47)

## ADR

`docs/adr/0014-granted-ineligible-resource-disclosure.md`.

**Threat boundary, in one paragraph:** the boundary is the grant, computed by
`ProjectResourceGrantPort.grantedToProject(projectId)` (invariant 2). Everything
that call returns for this Project's `projectId` may now be named back to it,
in full, with the Engine's own ineligibility reason attached (missing
capability, wrong `kind`, partial capability match). Everything that call does
not return for this `projectId` — never granted, or granted to a different
project — does not exist in the response at any level of detail: no entry, no
identifier, no count, no placeholder, no ordering hint. The disclosure moves
entirely inside a boundary the Project already sits inside; it draws no new
line across projects, machine registries, or global inventories. An anonymous
count/aggregate for non-granted resources was rejected in the ADR because
cardinality alone still leaks facts about another project's or the machine's
inventory across the boundary.

## What was built and where

- **Wire contract**: `contracts/openapi/local-api.v1.yaml` — new schema
  `ProjectIneligibleResource` (`{candidate, reason}`), and a new **optional**
  property `ineligibleGrantedResources` on `ProjectResourceBindingChoice`.
  Neither `ProjectResourceChoices.items` nor `ProjectResourceBindingChoice.candidates`
  changed shape or meaning — both remain restricted to eligible, project-scoped
  resources only.
- **Domain types**: `packages/project-runtime/src/project-types.ts` —
  `ProjectIneligibleResource` interface; `ProjectResourceBindingChoice` gains
  the same optional field. Re-exported from `apps/engine/src/projects/types.ts`.
- **Engine computation**: `apps/engine/src/projects/service.ts`, function
  `resourceChoices` plus two new helpers, `ineligibleGrantedResourcesFor` and
  `ineligibilityReason`. For each Slot: `candidates` (the eligible list) now
  also excludes a granted resource that shares the Slot's bound `ref` but a
  different `kind` (previously it was wrongly left eligible by the capability-only
  filter). Every granted resource excluded from `candidates` is then named with
  a reason:
  - same ref as the Slot's binding, different `kind` → "wrong kind";
  - satisfies none of the Slot's required capabilities → "missing capability";
  - satisfies some but not all → "partial capability match".
  The field is present only when the list is non-empty (never an empty array),
  and entries are sorted by `kind/ref` for determinism.
- **Docs**: `docs/contracts/PROJECT_CONFIG_V1.md` and
  `docs/contracts/LOCAL_API_V1.md` updated — the "never a non-granted
  resource" half of the old rule is restated as unchanged; the "never a
  partial match" half is marked superseded by ADR 0014, pointing at the new
  field.
- **Generated code**: `apps/engine/src/api/generated/local-api.ts` regenerated
  via `pnpm generate` (never hand-edited); `pnpm generate:check` passes.
  `apps/macos/JarvisAPI/openapi.yaml` is a symlink to the same contract file,
  so `swift test`'s build plugin regenerates the Swift client from the same
  source during `pnpm verify`; no `apps/macos/` file was hand-edited.

## Proving a non-granted resource never leaks

Two seams, both real (no mocks of the policy under test):

1. **Application Harness, unit-classified (`apps/engine/src/projects/service.test.ts`,
   new `describe("Granted-but-ineligible resource disclosure (ADR 0014)")`)** —
   real SQLite (`better-sqlite3`), a real temp repository directory, a real
   `ModuleHost` built from the actual bundled module manifests, and a
   hand-written `ProjectResourceGrantPort` fake that returns **different**
   resources for `"token-warehouse"` and `"other-project"`. It proves:
   - `runtime/codex-primary` (bound) carries status `"bound"`;
   - a same-ref, wrong-`kind` grant is absent from `agentRuntime.candidates`
     and named in `agentRuntime.ineligibleGrantedResources` with a reason
     mentioning `kind "connection"`;
   - a partial-capability grant is absent from `sourceControl.candidates` and
     named with a reason mentioning the one capability it does provide;
   - a zero-capability-match grant is absent from `tickets.candidates` and
     named with "none of the required capabilities";
   - Slot order is alphabetical and the same call is idempotent;
   - **`JSON.stringify(choices)` does not contain `"runtime/other-project-secret"`
     anywhere** — the ref granted only to `"other-project"` — which is the
     literal acceptance criterion ("assert its identifier appears nowhere in
     the serialized payload, not merely that the candidate array omits it").
2. **Application Harness, HTTP (`apps/engine/test/projects.integration.test.ts`)** —
   the real built engine binary, over real loopback HTTP, exercising the
   existing "gets and replaces schema-valid Local Bindings" test. The
   `"github"` Module Instance is a real, naturally-granted candidate (it is
   the Project's own configuration) that satisfies only one of
   `sourceControl`'s two required capabilities; the added assertions confirm
   it is named in `sourceControl.ineligibleGrantedResources` with the Engine's
   reason, absent from `sourceControl.candidates`, and that `tickets` (which
   it fully satisfies) carries no such field. The response is also validated
   against the live OpenAPI schema (`validateResourceChoices`, AJV against
   `contracts/openapi/local-api.v1.yaml`) and decoded through the generated
   Local API TypeScript types (`components["schemas"]["ProjectResourceChoices"]`
   from `apps/engine/src/api/generated/local-api.ts`) without a cast to `any`
   — the "generated-client decodes the versioned result" proof. Because the
   running engine always wires `EmptyProjectResourceGrants` (external
   connection/runtime/MCP registries are not implemented yet — the same
   documented gap `docs/architecture/PROJECTS.md` already states), the
   HTTP-level Harness cannot itself construct an external-grant scenario;
   that is exactly what the unit-classified Harness above supplies with a
   real `ProjectResourceGrantPort` fake, per the existing precedent in the
   same file (`"accepts only an explicitly granted external candidate..."`).

## Commands run, with actual results

| Command | Result |
|---|---|
| `git checkout -b agent/47-resource-eligibility-reasons` | branch created from `main` |
| `pnpm generate` | regenerated `apps/engine/src/api/generated/local-api.ts` (7-line diff, additive) |
| `pnpm typecheck` (`tsc --noEmit`) | pass, no errors |
| `pnpm contracts:check` | `contracts ok — 15 schemas, 4 event examples, 4 manifests, 31 API paths` |
| `rtk proxy npx vitest run --project unit apps/engine/src/projects/service.test.ts` | `Test Files 1 passed (1)`, `Tests 7 passed (7)` |
| `rtk proxy npx vitest run --project integration apps/engine/test/projects.integration.test.ts` | `Test Files 1 passed (1)`, `Tests 96 passed (96)` |
| `rtk proxy pnpm verify` (1st run, background, bounded poll) | **failed** — `generate:check`'s `git diff --exit-code` flagged the (correct, expected) diff against `HEAD` because the contract/regenerated-file changes were not yet staged |
| staged explicit paths (`git add <files>`, no `-A`/`.`) | — |
| `rtk proxy pnpm verify` (2nd run) | **failed** — `prettier --check .` flagged `service.ts`/`service.test.ts` formatting |
| `npx prettier --write apps/engine/src/projects/service.test.ts apps/engine/src/projects/service.ts` | reformatted; re-staged |
| `rtk proxy pnpm verify` (3rd run, background, bounded poll via Monitor, never `tail -f`) | **pass**, exit code 0 — `generate:check`, `contracts:check`, `lint`, `typecheck`, `arch:check`, `build:engine`, `test` (6 files / 43 tests), `test:integration` (11 files / 173 tests), `build:app`, `test:swift` (83 XCTest cases + 0 swift-testing cases, all passed) |

No orphaned `xctest`/`swift-test` processes were found before the Swift stage
(`pkill -f xctest`/`pkill -f swift-test` found nothing to reap; confirmed with
`ps aux`).

## Acceptance checklist — item by item

Ticket criteria:

- [x] Product/security decision recorded — made by the repository owner
      2026-09-06, restated verbatim in ADR 0014.
- [x] ADR records rationale, threat boundary, compatibility/versioning
      consequences — `docs/adr/0014-granted-ineligible-resource-disclosure.md`.
- [x] Versioned contract represents permitted ineligible-resource eligibility
      + Engine-owned reason without weakening project scoping —
      `ProjectIneligibleResource` / `ineligibleGrantedResources`, computed
      only from `scopedCandidates` (project-granted).
- [x] Engine is sole authority; clients reproduce no rules — all eligibility
      and reason computation lives in `apps/engine/src/projects/service.ts`;
      nothing added to `apps/macos/`.
- [x] Local API and regenerated Swift client expose the result consistently —
      OpenAPI updated, `pnpm generate` run, `swift test`'s build plugin
      regenerates the Swift client from the same (symlinked) contract during
      `pnpm verify`; 83/83 Swift tests still pass unmodified.
- [x] Application Harness test proves eligible + each permitted ineligible
      case + forbidden resources stay undisclosed — see "Proving a
      non-granted resource never leaks" above.
- [x] Contract docs, examples, generated artifacts and compatibility tests
      changed together — OpenAPI, `PROJECT_CONFIG_V1.md`, `LOCAL_API_V1.md`,
      generated TS types and both test files landed in the same change.

Mission gates:

- [x] A non-granted resource appears nowhere, asserted by test (`JSON.stringify`
      check in `service.test.ts`).
- [x] No Project Slot UI, SwiftUI view or presentation model added; no new
      Swift test — only the build-plugin-regenerated client code changed
      under `apps/macos/`, and only as a byproduct of `swift test`'s own
      codegen step, not a hand edit.
- [x] Every wire schema addition is optional — `ineligibleGrantedResources`
      is not in `ProjectResourceBindingChoice`'s `required` array; `reason`
      and `candidate` are required only within the new
      `ProjectIneligibleResource` object itself, which is new and thus has no
      pre-existing fixture to break.
- [x] No generated file hand-edited; `pnpm generate:check` passes (see table).
- [x] No commit message carries `Fixes`/`Closes`/`Resolves`.
- [x] No GitHub issue created, edited, labelled, commented on or closed —
      only `gh issue view 47` (read) was run.
- [x] Work committed on `agent/47-resource-eligibility-reasons`, never staged
      on `main`.
- [x] **No visual change — engine, contracts and ADR only.**
- [x] `pnpm verify` passes on the branch, each stage reported with its actual
      result (see table).
- [x] Staged by explicit paths; no `git add -A`/`git add .` used anywhere.
- [ ] Merge `--no-ff` into `main`, re-verify on merged `main`, push as a plain
      fast-forward, confirm `origin/main` equals local `main` — pending as of
      this writing; completed and confirmed in the same mission run before
      hand-off (see final commit/merge/push log below once done).
- [x] `reports/review-report.md` and `reports/retro.md` written and committed
      alongside the code.

*(The one item shown pending above is completed later in this same mission
run; this file is updated/finalized before the mission's last commit.)*
