# MISSION-0021 — Activate from Project Wizard step 5 (#55)

## User request

Implement ticket **#55**, the last slice of #29, with a Sonnet execution team. One mission only.

## Objective

Let the user activate from the Project Wizard. `Activate` is enabled only for the Project whose current validation report succeeded, and the Wizard shows the resulting active state once activation returns. Any edit to the composition or Local Bindings revokes the affordance immediately, as the existing readiness signal already does.

An activation failure is explained, not guessed: the Wizard names what blocked it and leaves the displayed state consistent with the engine.

## Mission type

small-feature

## Complexity

M

## What already exists

- **#53** shipped `POST /v1/projects/{projectId}/activate`, guarded by a `compositionFingerprint` the client carries back from the validation report it displayed. Two stable error codes: `project.activation-not-validated`, `project.activation-report-stale`.
- **#54** made activation open the derived subscriptions; `GET /v1/projects/{projectId}/subscriptions` serves them.
- **#45** already built the readiness signal: `ProjectDetailPresentation.activationReadinessExplanation`, rendered in `ProjectDetailView.swift` as "Ready to activate" / "Not ready to activate". This slice turns that presentation signal into a real action — it does not rebuild it.

## The detail that decides this slice

`compositionFingerprint` is **optional** on the validation report wire schema (it had to be, or it would have broken the existing Swift fixtures). The Wizard must carry the fingerprint **from the exact report it displayed** into the activate call, and must refuse to activate when it has none rather than sending a guess or omitting it. That is what makes "only the current successful report can activate" true on the client side as well as the engine side.

## Expected behavior

- `Activate` is enabled only for the selected Project whose current validation report succeeded; every other state explains why the affordance is unavailable, reusing the existing readiness vocabulary rather than inventing a second one.
- Editing the Portable Configuration or the Local Bindings revokes the affordance immediately, without waiting for a new report — the same revocation the stale-report signal already performs.
- A successful activation shows the Project as active in the Wizard and in the Project list.
- A rejected activation — no report, stale report, engine failure — is shown as a structured, actionable explanation, **visually and textually distinct from an invalid validation report**. An engine error must never look like a validation finding.
- A failed activation leaves the displayed Project state consistent with the engine state.

## Non-goals

- No engine, contract or generated-client change. #53 and #54 shipped the API; it is fixed.
- No subscription inspection UI — #54's endpoint exists, but surfacing it is not this ticket.
- No pause, deactivate or archive affordance.
- No runtime or execution visibility — #18 owns that.

## Constraints

- `AGENTS.md` is authoritative. Swift uses structured concurrency and the generated API types; **UI code contains no engine business logic** — the decision to allow activation belongs to the engine, and the client only reflects and forwards it.
- Follow the established seam: presentation logic in `apps/macos/JarvisCore/` (`ProjectDetailPresentation.swift`), testable without instantiating a `View`; `ProjectDetailView.swift` renders.
- The visual gate applies. Check the GUI session **before** building and again immediately before capturing.
- `pnpm verify` must pass, on the branch and on merged `main`.

## Allowed scope

- `apps/macos/JarvisCore/`
- `apps/macos/JarvisApp/Features/Projects/`
- `apps/macos/JarvisAppTests/`
- `docs/product/UX.md` — record the activation affordance and its failure states
- `.agentic/missions/MISSION-0021/`

## Disallowed changes

- `apps/engine/**`, `packages/**`, `contracts/**`. If the API cannot express what the affordance needs, that is a stop condition, not a change to make here.
- Any GitHub issue: create, edit, label, comment on or close **none**. No commit message may carry a `Fixes`/`Closes`/`Resolves` keyword.
- `git reset --hard`, `git clean -fd`, `git add -A`, `git add .`, `git push --force`, `rm -rf`.

## Acceptance criteria

Every checkbox in `acceptance-checklist.md`, which mirrors #55.

## Stop conditions

Stop and report rather than guessing when:

- the GUI session is locked — do not build, launch or capture;
- the report the Wizard displays does not carry a fingerprint the client can forward;
- an activation failure cannot be distinguished from a validation finding in the existing presentation model;
- the working tree carries changes this mission did not make;
- `pnpm verify` fails on a tree this mission did not break.

## Expected reports

- `.agentic/missions/MISSION-0021/reports/review-report.md`
- `.agentic/missions/MISSION-0021/reports/retro.md`
- the screenshots, in the same directory
