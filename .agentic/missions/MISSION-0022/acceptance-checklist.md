# MISSION-0022 — Acceptance checklist (#47)

## Ticket criteria

- [ ] A product/security decision records which non-eligible resources may be disclosed and at what detail level — made by the repository owner, restated in the ADR.
- [ ] An ADR records the rationale, the threat boundary, and the compatibility/versioning consequences of changing the non-disclosure rule.
- [ ] The versioned machine-readable contract represents permitted ineligible-resource eligibility and an Engine-owned reason without weakening project scoping.
- [ ] The Engine is the sole authority computing eligibility and reasons; clients reproduce none of those rules.
- [ ] The Local API and regenerated Swift client expose the versioned result consistently.
- [ ] An Application Harness test proves an eligible resource and each permitted ineligible case, including that forbidden resources remain undisclosed.
- [ ] Contract documentation, examples, generated artifacts and compatibility tests change together.

## Mission gates

- [ ] A resource not granted to the Project appears nowhere: no entry, no identifier, no count, no placeholder — asserted by test.
- [ ] No Project Slot UI, SwiftUI view or presentation model added; the slice ends at the generated-client proof.
- [ ] Every wire schema addition is optional, never required.
- [ ] No generated file hand-edited; `pnpm generate:check` passes.
- [ ] No commit message carries a `Fixes`/`Closes`/`Resolves` keyword.
- [ ] No GitHub issue created, edited, labelled, commented on or closed.
- [ ] The work was committed on `agent/47-resource-eligibility-reasons`, never staged on `main`.
- [ ] "No visual change — engine, contracts and ADR only" stated explicitly in the report.
- [ ] `pnpm verify` passes on the branch, each stage reported with its actual result.
- [ ] Staged by explicit paths; no `git add -A`.
- [ ] Merged `--no-ff` into `main`, `pnpm verify` re-run on merged `main`, pushed as a plain fast-forward, `origin/main` confirmed equal to local `main`.
- [ ] `reports/review-report.md` and `reports/retro.md` written and committed alongside the code.
