# MISSION-0004 Review Report

## Result

This run found no leftover unmerged ticket branch, selected the locally satisfied frontier correctly, and completed only #36. The branch was merged into local `main` after its ticket commit and both branch and merged `main` passed `pnpm verify`.

| Issue | Title | Branch | DoD | Verification |
|---|---|---|---|---|
| #34 | Expose project-scoped composition choices | `agent/34-expose-project-scoped-composition-choices` | Complete; merged locally | `pnpm verify` passed |
| #35 | Choose the guided composition interaction grammar | `agent/35-choose-guided-composition-grammar` | Complete; merged locally | `pnpm verify` passed |
| #36 | Guide starting point and Module Instance choices | `agent/36-guide-starting-point-module-choices` | Complete; merged locally | `pnpm verify` passed on branch and merged `main` |
| #37 | Build sentence-style Automation Rules | not started | Remaining; next frontier | — |
| #38 | Structure every bundled Module Configuration | not started | Blocked by #37 | — |
| #39 | Guide project-scoped resource bindings | not started | Remaining; also on frontier after #36 | — |
| #40 | Review and save Project composition drafts | not started | Blocked by #38 and #39 | — |

Issues remain open as required. Labels were not used as the completion frontier.

## #36 delivery

The versioned composition-choice response now includes:

- `GitHub Development` and `Custom composition` starting points;
- a canonical GitHub Development Portable Configuration derived from the imported Project's metadata, repository, commands and conventions;
- validated bundled Module Package metadata;
- deterministic Module Instance cards with human names/descriptions, consumed and emitted Events, required capabilities, compatibility and validator-owned missing resources;
- the existing Event routing choices for the saved or proposed Draft.

The canonical template creates GitHub, Automation Rules and Development Module Instances, the three documented Slots, safe configuration defaults and the `agent:ready` Rule. Previewing or selecting it does not persist the Draft and creates no Local Binding or grant.

The macOS Project Wizard exposes both starting points and human-led Module Instance cards. Technical IDs, versions and contract IDs are under `Advanced`. Draft edits request a new Engine preview; revision checks prevent stale responses replacing newer edits. Tests demonstrate selection, human/accessibility presentation inventory, input preservation, enable/disable and package-change refresh.

## TDD evidence

- Application Harness test first failed because `startingPoints`, `modulePackages` and `moduleInstances` were absent.
- XCTest first failed to compile because the composition guide state and starting-point actions did not exist.
- Focused integration and Swift tests passed after implementation.
- No filesystem or SQLite mock was introduced; tests use the real Engine, temporary repository and SQLite.

## Code review

### Standards

No blocking finding remains. The review used `AGENTS.md`, `docs/agents/coding-standards.md`, the DDD invariants and the smell baseline. A first review found that missing resources were inferred only from binding presence; this was corrected to use Project Validation findings, so inaccessible and unresolved Engine/repository/capability resources remain visible. Event cards were also changed to lead with contract-owned human labels while keeping contract IDs under `Advanced`. Generated-client use, structured concurrency and project boundaries conform to repository standards.

### Spec

No blocking finding remains. Every #36 criterion is represented in the Local API/Application Harness and Swift/XCTest seams. No wizard-only state is persisted, no machine-local resource is implicitly granted, unrelated Draft input survives refresh, and contract/docs/example changes are synchronized.

## Definition of Done for #36

- Acceptance criteria demonstrated at Application Harness and XCTest seams.
- Red observed before green; focused tests, typecheck and full verification pass.
- Relevant failure and stale-response behavior is actionable; preview remains read-only.
- OpenAPI, generated TypeScript, examples and source-of-truth docs are synchronized.
- `pnpm arch:check` passes; no applied migration changed.
- No secret, credential, personal path or new dependency was introduced.
- No new hard-to-reverse architecture decision or new context vocabulary required an ADR/`CONTEXT.md` update.
- Two-axis code review completed and blocking findings were fixed.
- The required branch and local `--no-ff` merge were used; nothing was pushed and no PR was opened.

## Remaining work

#37 and #39 are now both eligible from the blocking graph; the prescribed lowest-numbered next ticket is #37. #38 follows #37, and #40 waits for #38 and #39.
