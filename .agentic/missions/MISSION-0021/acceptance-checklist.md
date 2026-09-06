# MISSION-0021 — Acceptance checklist (#55)

## Ticket criteria

- [ ] `Activate` is enabled only for the selected Project whose current validation report succeeded; every other state explains why the affordance is unavailable.
- [ ] Editing the composition or Local Bindings revokes the affordance immediately, without waiting for a new report.
- [ ] A successful activation shows the Project as active in the Wizard and in the Project list.
- [ ] A rejected activation — no report, stale report, engine failure — is shown as a structured, actionable explanation, distinct from an invalid validation report.
- [ ] A failed activation leaves the displayed Project state consistent with the engine state.
- [ ] XCTest covers the affordance states and the state transition.

## Mission gates

- [ ] The Wizard carries the fingerprint from the exact report it displayed, and refuses to activate when it has none — asserted by test.
- [ ] The existing readiness vocabulary from #45 is reused, not duplicated.
- [ ] No engine decision recomputed in Swift.
- [ ] GUI session checked with `ioreg` **before** building; result stated in the report.
- [ ] Screenshots captured into `reports/`: Activate enabled, the Project active after success, a rejection with its explanation.
- [ ] A disposable fixture Project was used; the user's own `jarvis` Project was not touched, or was reverted and disclosed.
- [ ] No capture carries personal information or another app's content.
- [ ] No file under `apps/engine/**`, `packages/**` or `contracts/**` changed.
- [ ] No commit message carries a `Fixes`/`Closes`/`Resolves` keyword.
- [ ] No GitHub issue created, edited, labelled, commented on or closed.
- [ ] The work was committed on `agent/55-wizard-activate`, never staged on `main`.
- [ ] `pnpm verify` passes on the branch, each stage reported with its actual result.
- [ ] Staged by explicit paths; no `git add -A`.
- [ ] Merged `--no-ff` into `main`, `pnpm verify` re-run on merged `main`, pushed as a plain fast-forward, `origin/main` confirmed equal to local `main`.
- [ ] `reports/review-report.md` and `reports/retro.md` written and committed alongside the code.
