# MISSION-0004 Review Report

## Result

This run found no leftover unmerged ticket branch. Locally merged #34–#37 count as satisfied despite their open issue states. Following the mission's explicit work order (`#37/#39`, then `#38`), only #39 was implemented on `agent/39-guide-project-scoped-resource-bindings`. The branch passed `pnpm verify`, was committed and merged into local `main` with `--no-ff`, and merged `main` passed `pnpm verify`.

| Issue | Title | Branch | DoD | Verification |
|---|---|---|---|---|
| #34 | Expose project-scoped composition choices | `agent/34-expose-project-scoped-composition-choices` | Complete; merged locally | `pnpm verify` passed |
| #35 | Choose the guided composition interaction grammar | `agent/35-choose-guided-composition-grammar` | Complete; merged locally | `pnpm verify` passed |
| #36 | Guide starting point and Module Instance choices | `agent/36-guide-starting-point-module-choices` | Complete; merged locally | `pnpm verify` passed |
| #37 | Build sentence-style Automation Rules | `agent/37-build-sentence-style-automation-rules` | Complete; merged locally | `pnpm verify` passed |
| #38 | Structure every bundled Module Configuration | not started | Remaining; next ticket | — |
| #39 | Guide project-scoped resource bindings | `agent/39-guide-project-scoped-resource-bindings` | Complete; merged locally | `pnpm verify` passed on branch and merged `main` |
| #40 | Review and save Project composition drafts | not started | Blocked by #38 and #39 integration | — |

## #39 delivery

- The Local API now returns deterministic, Engine-owned resource eligibility per Slot for saved configurations and read-only proposed Drafts.
- Eligibility intersects explicit Project grants, the Slot capability, and all enabled Module Instance requirements routed through that Slot. Binding validation enforces the same policy.
- Responses distinguish `bound`, `available`, `missing`, `inaccessible`, and `incompatible`, with impacted Module Instances and an exact repair action. Only fully eligible candidates enter picker inventories.
- Selected Module Instances are candidates only for capabilities declared by their Manifest; templates and previews do not create grants or Local Bindings.
- The macOS resource presentation exposes status, capability requirements, impact, repair guidance, reload, accessible labels/hints, and eligible-only pickers.
- Binding changes refresh resource and Event choices while preserving unrelated Draft input. Save/reopen continues to load Portable Configuration and Local Bindings separately.
- OpenAPI, generated TypeScript, generated-at-build Swift mappings, contract docs, Capability Catalog, UX, context vocabulary, and a resource-choice example are synchronized.

## TDD evidence

- XCTest was first observed failing to compile because resource choice state, presentation rows, statuses, accessibility inventory, and guidance did not exist.
- The Application Harness was first observed failing because `/binding-candidates` lacked Slot guidance.
- Focused TypeScript, Application Harness, and XCTest runs passed after implementation. Tests use the real Engine and temporary SQLite/repositories; no filesystem or SQLite mock was added.
- The complete `pnpm verify` gate passed, including generated-contract checks, lint, typecheck, architecture checks, engine/app builds, unit/integration tests, and all Swift tests.

## Code review

### Standards

No blocking finding remains. Review used `AGENTS.md`, the Definition of Done, and the smell baseline. Project-scoped policy remains in Project Runtime/Engine rather than SwiftUI; generated contracts remain generated; no cross-context import, applied migration edit, new dependency, secret, credential, or personal path was introduced. A review finding that Draft edits initially refreshed Event choices but not resource choices was fixed by adding the read-only resource preview operation and refreshing both under the same revision guard.

### Spec

No blocking finding remains. Review checked eligible-only project grants, Module Instance capability conjunction, empty/inaccessible/incompatible states, exact repair guidance, no template grants, Local Bindings separation, Draft preservation, Event/resource refresh, canonical reopen, accessibility, and synchronized contracts/docs/examples. Repository access continues through the existing dedicated Repository Grant control and Engine validation; no real provider/runtime registry was introduced because those integrations are explicitly out of scope.

## Definition of Done for #39

- Acceptance criteria are demonstrated at Application Harness, Project Service, and XCTest/presentation seams.
- Red was observed before green; focused tests, typecheck, and the full gate pass.
- Unknown, incompatible, inaccessible, empty, stale availability, invalid binding, refresh-failure, and unrelated-input preservation paths are covered where relevant.
- OpenAPI, generated TypeScript, Swift generated-client adapters, examples, Capability Catalog, Project Configuration contract, Local API docs, UX, and Project Runtime vocabulary are synchronized.
- `pnpm arch:check` passes; no migration changed.
- No secret, credential, personal path, dependency, filesystem mock, or SQLite mock was introduced.
- No ADR was required: the change extends the existing project-scoped grant and Local Binding architecture.
- Two-axis code review completed and its blocking Draft-preview finding was fixed.
- Required branch and local `--no-ff` merge used; nothing pushed and no PR opened.

## Remaining work

#38 is next. #40 remains blocked until #38 and #39 are both locally integrated. Issues remain open as required, and labels are not used as the completion frontier.
