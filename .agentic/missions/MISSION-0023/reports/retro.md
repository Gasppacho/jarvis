# MISSION-0023 — Retro

## What slowed this mission down

1. **Branch drift onto `main` — third mission in a row.** All investigation and
   every edit in this mission were made while `HEAD` was `main`, and the
   coordinator caught it mid-task (`git branch --show-current` → `main`, 18
   files dirty). The execution plan says "Create the branch first," but
   nothing in the mission material *checks* that the branch was actually
   created before work starts — the instruction is easy to read, agree with,
   and then skip once deep in an investigation pass that starts with `git
   status`/`grep`/`Read` and never touches `git checkout`. This is recorded as
   happening on three consecutive missions now.

   **Recommendation for `.agentic/material/`:** add a mechanical gate, not
   another sentence of prose. A short pre-flight script or checklist step that
   *runs* `git branch --show-current` and refuses to continue (or loudly
   flags) when it equals `default_base_branch` from `.agentic/config.yaml`,
   invoked right after reading `execution-plan.md` and before the first `Read`
   or `Edit` of a source file. Prose in the plan didn't hold three times
   running; a check that fails loudly might.

2. **The GUI session locked mid-mission**, not just at the start. The mission
   material's Step 1 frames the `ioreg` check as a one-time gate before
   building. The playbook does note "it can lock during a long build," but
   this mission's TypeScript/Swift compile-and-test phase (headless, no
   screen involved) took long enough that the session locked well before the
   build:app/capture step was reached, having been unlocked at mission start.
   Distinguishing clearly, in the playbook, between headless verification
   (build:engine, typecheck, swift build, swift test — safe regardless of lock
   state) and the visual-evidence sequence (build:app, open, screencapture —
   gated) would have let this mission proceed with more confidence instead of
   reasoning it out mid-task. Recommend making that distinction explicit in
   `visual-verification-gate.md`.

## What went right

- The consumer inventory (kernel flattening, Project Runtime projection,
  OpenAPI, generated TS client, generated Swift client, hand-written Swift
  fixtures) was complete on the first pass: `pnpm typecheck` was clean
  immediately after the TypeScript-side edits, with zero follow-up fixes
  needed — a good sign the read-before-edit inventory step actually worked
  when it was followed.
- Distinguishing `ModulePackage.requires` (the thing being migrated) from
  three other, unrelated fields that also happen to be named `requires` or
  `requiredCapabilities` (`ProjectSlotDraft.requires`, the Project Slot's
  singular capability-id string; `ProjectModuleCapabilityRequirement` /
  `.composition(...).requires`, already rich and never flattened;
  `ProjectResourceBindingChoice.requiredCapabilities`, a Slot-eligibility
  capability-id list) avoided a scope-creep migration of things the ticket
  never asked to change.
