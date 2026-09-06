# MISSION-0020 — Retro

## What slowed this mission down

- **The `rtk` Claude Code hook mis-rewrites bare `pnpm <script>` Bash calls in this
  environment.** `pnpm lint` (which is literally `prettier --check .` in this repo's
  `package.json`) came back as `ESLint output (JSON parse failed...)` /
  `Command "eslint" not found` — a false failure with no relation to the actual project
  tooling (this repo has no ESLint at all). It cost one wasted round-trip figuring out
  whether the project was broken before realizing the hook itself was misinterpreting the
  command. `rtk proxy <cmd>` (documented in the user's own RTK.md as the raw,
  unfiltered escape hatch) reliably ran the real script. Every verification command in
  this mission was run through `rtk proxy` once this was discovered.
- **`pnpm generate:check`'s `git diff --exit-code` is stateful in a way that isn't
  obvious from the script name.** It only passes once the regenerated file is already
  staged (or committed) — running it against an unstaged regeneration always "fails" even
  when generation is perfectly up to date, because `git diff` (no `--cached`) diffs
  against the index, not `HEAD`. Worth stating explicitly next time so it isn't mistaken
  for a real drift bug mid-task.
- Otherwise the ticket was well-scoped: the design question had a decisive, easy-to-find
  answer once `docs/architecture/EVENTS.md` "Routing" and the #53 `PROJECTS.md`
  "Activation" paragraph were read side by side, and the existing #53 integration test
  (`"opens no subscription, delivers no event and leaves a second Project unaffected"`)
  independently confirmed the derived approach by already asserting the exact table list
  with no subscription table in it. No rework, no blocked step, no ambiguity in the
  acceptance criteria.

## What should change in `.agentic/material/`

- Record the `rtk proxy` escape hatch as a standing note for every future mission that
  runs `pnpm <script>` through Bash in this environment, so the next execution team
  doesn't re-diagnose the same false ESLint failure. Something like: "If a bare
  `pnpm <script>` command in this repo returns an ESLint-shaped error that doesn't match
  the script's actual definition in `package.json`, re-run it as `rtk proxy pnpm
  <script>` before assuming the project is broken."
- Record the `generate:check` staging nuance next to the Invariant 12 material: "stage
  (`git add`) the regenerated file under `apps/engine/src/api/generated` before running
  `pnpm generate:check` or `pnpm verify` mid-task, or the check will report a false
  drift against your own unstaged regeneration."
