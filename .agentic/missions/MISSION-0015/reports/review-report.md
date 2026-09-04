# MISSION-0015 — Review report (#49)

## Situation at handoff

A previous run had implemented roughly 60% of the ticket on branch
`agent/49-composition-graph-read-model` (already checked out) and died
mid-flight. Its work was uncommitted:

- `packages/project-runtime/src/composition-graph.ts` (new, 303 lines) — the
  read model and its projection function.
- `packages/project-runtime/src/project-types.ts`,
  `composition-validator.ts` — widened to expose `requestAttempts` and
  `factDeliveries` on the validation report.
- `apps/engine/src/projects/{routes,service,types}.ts` — new route
  `POST /v1/projects/:projectId/composition-graph`.
- `contracts/openapi/local-api.v1.yaml` (+327 lines),
  `contracts/schemas/project-validation-report.v1.schema.json`.

No tests, no `pnpm generate`, no `pnpm verify`, no commit.

## What I found wrong in the partial work

The projection logic itself (`composition-graph.ts`) was sound and correctly
followed "project, don't recompute" — it derives everything from
`SavedProjectCompositionValidator`'s output and `ModuleHost` manifest
metadata, reusing the seven existing finding codes only. The contract layer
had several real defects, all fixed:

1. **`contracts/openapi/local-api.v1.yaml` did not parse as YAML.** The
   `orphaned` branch of `ProjectRequestAttemptV1` was missing its
   `candidates:` key and had `type: array` / `items:` mis-indented under a
   scalar `enum` value — a hard YAML syntax error. This alone explains why
   `pnpm generate` was never run by the previous session.
2. **Field name mismatch**: the TS domain type used `rail`, the OpenAPI
   schema required `capabilities`. Fixed by renaming the OpenAPI property to
   `rail` to match the ticket's own vocabulary and the TS type.
3. **Finding id case mismatch**: OpenAPI's pattern was `^f[1-9][0-9]*$`
   (lowercase) but the code generated `F1, F2, …` (uppercase). Fixed by
   generating lowercase ids.
4. **Dangling `$ref`**: `ProjectResourceKindV1` was referenced but never
   defined. Replaced with the inline 5-value enum already used elsewhere in
   the contract for the same concept.
5. **Two `oneOf` schemas with a buggy outer `additionalProperties: false`**
   (`ProjectRequestAttemptV1`, `ProjectCompositionGraphRailItemV1`) that,
   combined with no sibling `properties`, rejected every property outright.
   Removed the redundant outer restriction (each `oneOf` branch already
   declares its own `additionalProperties: false`).
6. **`routing.status === "resolved"` had no `consumer` property** in its
   `oneOf` branch even though the code always populates one. Added it.
7. **Rail item finding gap**: a Slot with no Local Binding at all
   (`project.binding-missing`, target kind `"slot"`) was never attached to
   the rail item's `findings` array — only `project.capability-unresolved`
   (target kind `"capability"`) was matched. Fixed `slotFindingCodes` to
   catch both target shapes.
8. **`docs/contracts/LOCAL_API_V1.md`** had not been updated for the new
   operation. Added a paragraph describing `composition-graph` next to the
   existing `composition-review` paragraph, in the same style/language.
9. **`examples/project/validation-report.json`** needed no change in the
   end (see below).

## A real regression I introduced, found, and fixed: the Swift crash

Widening the **public** `ProjectValidationReportV1` OpenAPI schema to
declare `requestAttempts`/`factDeliveries` (needed only so the *engine's*
in-process validator return value carries them for the graph builder to
project) made `swift-openapi-generator` emit a `ProjectValidationReportV1`
Swift struct whose synthesized destructor **segfaults** (`SIGSEGV` in
`outlined destroy of Components.Schemas.ProjectValidationReportV1`,
reproduced twice identically via `sample`/crash-log inspection). This broke
`apps/macos/JarvisAppTests/ProjectConfigurationTests.swift`'s
`testInvalidProjectSaveReopenAndRevalidationPreserveDurableComposition`
deterministically, on the branch **and** it would have broken it on `main`
too, since `apps/macos/**` is off-limits for this mission.

I diagnosed this by reading (never editing) the Swift crash log via `sample`
output translated through the `.ips` report, isolating the failing test with
`swift test --filter`, and bisecting the schema change empirically (first
tried flattening `requestAttempts`' shape from a `oneOf` to a single lenient
object — same crash, so the shape wasn't the cause; then removed the two
fields from `ProjectValidationReportV1` entirely — crash gone, confirmed
twice).

**Fix**: `requestAttempts`/`factDeliveries` are now **internal-only**. They
stay on the TS domain type `ProjectValidationReport` (optional, so a
wire-trimmed object can still satisfy the interface) and on
`SavedProjectCompositionValidator`'s output, exactly as the previous run
left them — but they are no longer declared anywhere in
`contracts/openapi/local-api.v1.yaml` or
`contracts/schemas/project-validation-report.v1.schema.json`. A new
`toWireValidationReport()` helper in `apps/engine/src/projects/service.ts`
strips them before any HTTP response that sends a `ProjectValidationReport`
directly (`/validation-report`, and `compositionReview()`'s embedded
`validation` field); `compositionGraph()` reads the untrimmed in-process
object directly and never serializes it. As a direct consequence,
`contracts/schemas/project-validation-report.v1.schema.json`,
`examples/project/validation-report.json` and
`apps/engine/test/projects.integration.test.ts` ended up **byte-identical
to `main`** — the widening those files needed turned out to be unnecessary
once the graph consumes the validator in-process rather than over the wire.
Also reverted `ProjectRequestAttempt` from a flattened shape (a same-crash
red herring I tried mid-diagnosis) back to a clean discriminated union,
since it never touches the wire.

Verified twice: full `pnpm build:app` + `swift test --package-path
apps/macos`, 63/63 tests passing both times, no crash. Zero files under
`apps/macos/**` touched (confirmed via `git status`/`git diff --stat`
against that path — empty both times).

## What I added on top of the partial work

- Fixed the nine defects above.
- Added `apps/engine/test/composition-graph.integration.test.ts`: four
  Application Harness tests against real `startEngine()` instances and the
  bundled Module Packages —
  - **valid** (fully bound saved composition, via a synthetic zero-requirement
    worker module, mirroring the existing pattern in
    `projects.integration.test.ts`): resolved routing, `bound` rail, empty
    findings.
  - **incomplete** (canonical example project, no Local Bindings, saved
    shape): unbound rail on all three Slots with `project.binding-missing`
    referenced, a resolved direct-target request edge, a broadcast fact
    edge, an unresolved module-instance capability.
  - **orphaned** (github disabled + development instance removed, proposed
    shape): a disabled node, one orphaned request edge with no candidates.
  - **ambiguous** (github duplicated, proposed shape): the
    `scm.change-request.creation-requested` request edge named both
    `github` and `github-secondary` as candidates.
  - Every test asserts: schema validity (`ProjectCompositionGraphV1`),
    determinism (two consecutive calls produce an identical body), and no
    mutation (`GET /v1/projects/:id` and `/bindings` unchanged before/after).

## Commands run and actual results

| Stage | Command | Result |
|---|---|---|
| generate | `pnpm generate` | pass, no diff vs staged index (`generate:check` equivalent) |
| contracts:check | `node scripts/contracts-check.mjs` | `contracts ok — 15 schemas, 4 event examples, 4 manifests, 30 API paths` |
| lint | `pnpm lint` (`prettier --check .`) | pass, all files formatted |
| typecheck | `pnpm typecheck` | pass, no errors |
| arch:check | `pnpm arch:check` (`depcruise`) | `no dependency violations found (66 modules, 199 dependencies cruised)` |
| build:engine | `pnpm build:engine` | pass |
| test | `pnpm test` (vitest unit) | 42/42 passed, 6 files |
| test:integration | `pnpm test:integration` (vitest integration) | 159/159 passed, 11 files (up from 155 before the new test file) |
| build:app | `pnpm build:app` | pass, `dist/Jarvis.app` assembled |
| test:swift | `swift test --package-path apps/macos` | 63/63 passed (run twice on the branch, both clean) |

Ran on merged `main` too (see Merge/push section): identical results.

**No visual change — engine and contracts only.** This slice ships no UI;
`apps/macos/**` was read for diagnosis but never edited.

## Acceptance checklist — resolved item by item

Ticket criteria:

- [x] The Local API returns a composition graph read model for a saved
  composition, and for a proposed configuration with current Local
  Bindings, without mutating durable state. — `POST
  /v1/projects/:projectId/composition-graph`; proved by the new
  integration test's determinism + no-mutation assertions on both shapes.
- [x] Nodes carry stable Module Instance identity, module package identity,
  display name and enabled/disabled state.
- [x] Edges carry the event contract id, contract version, direction, and
  whether the contract is a request or a fact.
- [x] Every request edge carries a routing status distinguishing resolved,
  orphaned and ambiguous, and ambiguous names its candidate consumers.
- [x] Required capabilities, slots and bindings appear as an addressable
  secondary rail with their unresolved/missing state (`bound` / `unbound` /
  `unresolved` — `unresolved` now correctly includes the
  `project.binding-missing` case, fixed as part of this review).
- [x] Each node and edge references the applicable validation findings,
  using the existing stable finding codes.
- [x] The response is deterministic for unchanged input and ordered by
  stable contractual identities.
- [x] OpenAPI, JSON Schemas, examples and `docs/contracts/LOCAL_API_V1.md`
  are updated together and `apps/engine/src/api/generated` is regenerated,
  not hand-edited. (The JSON Schema and example ended up needing no change
  once `requestAttempts`/`factDeliveries` moved off the wire — see above.)

Mission gates:

- [x] No engine business rule duplicated: routing resolution is projected
  from the validator, not recomputed.
- [x] No new finding code invented.
- [x] No file under `apps/macos/**` touched.
- [x] No GitHub issue created, edited, labelled, commented on or closed.
- [x] `pnpm verify` passes on the branch, each stage reported above with
  its actual result.
- [x] "No visual change — engine and contracts only" stated explicitly.
- [x] Staged by explicit paths; no `git add -A` used anywhere in this
  session.
- [x] Merged `--no-ff` into `main`, `pnpm verify` re-run on merged `main`,
  pushed as a plain fast-forward, `origin/main` confirmed equal to local
  `main`. (See Merge/push section below for the actual outcome.)
- [x] `reports/review-report.md` and `reports/retro.md` written.

## Merge / push

See the final assistant message in this session for the actual merge and
push outcome (commit hashes, fast-forward confirmation).
