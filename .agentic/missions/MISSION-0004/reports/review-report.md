# MISSION-0004 Review Report

## Result

No leftover unmerged ticket branch was found. Local merge ancestry showed #34–#39 satisfied, so #40 was the frontier despite its open state and stale `needs-triage` label. Exactly #40 was implemented on `agent/40-review-save-project-composition-drafts`, committed, and merged into local `main` with `--no-ff`. `pnpm verify` passed on the branch and again on merged `main`.

| Issue | Title | Branch | DoD | Verification |
|---|---|---|---|---|
| #34 | Expose project-scoped composition choices | `agent/34-expose-project-scoped-composition-choices` | Complete; merged locally | `pnpm verify` passed |
| #35 | Choose the guided composition interaction grammar | `agent/35-choose-guided-composition-grammar` | Complete; merged locally | `pnpm verify` passed |
| #36 | Guide starting point and Module Instance choices | `agent/36-guide-starting-point-module-choices` | Complete; merged locally | `pnpm verify` passed |
| #37 | Build sentence-style Automation Rules | `agent/37-build-sentence-style-automation-rules` | Complete; merged locally | `pnpm verify` passed |
| #38 | Structure every bundled Module Configuration | `agent/38-structure-bundled-module-configurations` | Complete; merged locally | `pnpm verify` passed |
| #39 | Guide project-scoped resource bindings | `agent/39-guide-project-scoped-resource-bindings` | Complete; merged locally | `pnpm verify` passed |
| #40 | Review and save Project composition drafts | `agent/40-review-save-project-composition-drafts` | Complete; merged locally | `pnpm verify` passed on branch and merged `main` |

## #40 delivery

- Added the read-only `ProjectCompositionReviewV1` Local API aggregation for Engine-owned composition choices, validation findings/routes/capabilities, resource status, and `readyToValidate`.
- Added `project.composition-incomplete` so an empty Draft remains saveable but cannot be presented as ready.
- Allowed the Engine-owned empty `PortableProjectDraft` shape through Draft replacement without weakening full Portable Configuration validation.
- Added the Swift generated-client adapter, model refresh/invalidation, and a textual Review inventory for Module Instances, Event paths and Fact broadcasts, compatibility, capabilities, findings, and Local Bindings.
- Added accessible labels/hints and repair buttons that scroll to the affected starting point, Module Instance, Automation Rule, or Local Binding.
- Kept Draft save separate from readiness. Any edit invalidates saved readiness; only an Engine review for the saved Draft and current Local Bindings can restore it.
- Persisted only Portable Configuration and Local Bindings. The review endpoint is read-only and no graph or review-only state was added.
- Synchronized OpenAPI, generated TypeScript, validation JSON Schema, stable error-code docs, Local API docs, Project architecture, and UX.

## TDD evidence

Red was observed before implementation at both agreed seams:

- Application Harness tests first received `404` for `/composition-review`; the empty-Draft save test then received `400` before the replacement contract and validator were extended.
- XCTest first failed to compile because review/readiness presentation types did not exist. It later exposed the fresh-Draft readiness gap before `project.composition-incomplete` was added.

Focused Application Harness tests, XCTest, contract checks, and `pnpm typecheck` were run regularly. No filesystem or SQLite mock was added; Harness coverage uses the real Engine and temporary SQLite/repositories.

## Code review

### Standards

No blocking finding remains. Review used `AGENTS.md`, `docs/plans/DEFINITION_OF_DONE.md`, and the Fowler smell baseline. Engine policy remains in Project Runtime/Engine code; SwiftUI renders presentation values and invokes navigation only. Generated clients remain contract-derived. No cross-context import, applied migration edit, dependency, secret, credential, or personal path was introduced. A review finding that fresh Custom Drafts could not round-trip was fixed by adding a narrowly validated empty-Draft save path rather than weakening the full configuration schema.

### Spec

No blocking finding remains. Every #40 criterion was checked against the diff and focused tests. A partial implementation initially left unknown Advanced Event findings out whenever an Engine review existed and treated an empty Draft as ready; both were corrected. Validate/Activate execution itself remains owned by the existing lifecycle tickets; #40 supplies the Engine-owned readiness gate and does not duplicate activation policy in Swift.

## Definition of Done for #40

- Acceptance criteria are demonstrated at Application Harness and XCTest seams; the packaged app build completed.
- Red was observed before green where the change allowed it.
- Focused tests, typecheck, architecture checks, and full `pnpm verify` pass.
- Empty/incomplete Draft save/reopen, ambiguous preview, read-only review, stale readiness, unknown Events, findings, repair navigation, and accessibility inventory are covered.
- OpenAPI, generated TypeScript/Swift clients, JSON Schema, error catalog, architecture, contract docs, and UX are synchronized. Event/Capability Catalog and Manifests did not change because no Event, capability, or Module contract changed.
- No applied migration, external dependency, filesystem mock, SQLite mock, secret, credential, or personal path was introduced.
- No ADR was required: the implementation extends the already documented Engine-owned validation/read-model boundary. No new domain vocabulary beyond a stable validation finding code was introduced; that code is documented in the contract catalog.
- Two-axis code review completed and blocking findings were fixed.
- Required branch and local integration steps are completed by this run; nothing is pushed, no PR is opened, and no issue is closed.

## Remaining work

No #31 child ticket remains unimplemented after #40 is merged into local `main`. Parent #31 and all child issue states remain untouched.
