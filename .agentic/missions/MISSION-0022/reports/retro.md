# MISSION-0022 — Retro

## What slowed this mission down

1. **The ticket's own three named reasons ("missing capability, wrong `kind`,
   partial capability match") do not map to three independent code paths in
   the existing model.** The Portable Configuration Slot schema
   (`ProjectSlotRequirement`) never declares an expected resource `kind` —
   only a required capability id. So "wrong kind" isn't a pre-existing,
   already-computed case waiting to be surfaced (unlike "missing"/"partial
   capability", which the existing `candidates` filter already silently
   dropped). Working out that "wrong kind" is only meaningfully reachable
   for a Slot that already has a Local Binding — by comparing a granted
   resource's `kind` against that binding's own recorded `kind` for the same
   `ref` — took real analysis time re-reading `resourceChoices`,
   `validateSlotBindings`, and the French contract sentence
   ("...du bon `kind`, et fournissant toutes les capabilities...") closely
   enough to see where each of the three clauses is actually enforced today.
   Cheaper next time: when a ticket names specific failure categories, grep
   for each category's current status/finding code *before* assuming they're
   symmetric; here two of three were "the same filter, just silent" and one
   was "not modeled at all yet."
2. **`pnpm generate:check`'s `git diff --exit-code` is index-relative, not
   generation-relative.** The first `pnpm verify` run failed there even
   though `pnpm generate` had already been run and the file was correct,
   simply because nothing was staged yet — so the working tree legitimately
   differed from `HEAD`. This cost one full `pnpm verify` round-trip
   (generate:check passes, but the run still aborts before reaching lint,
   etc., since it's a `&&` chain). Cheaper next time: stage the
   contract + regenerated-file pair immediately after running `pnpm generate`,
   before the first `pnpm verify` attempt, instead of after seeing it fail.
3. **One more full `pnpm verify` round-trip for two Prettier-unformatted
   files** (`service.ts`, `service.test.ts`) — `prettier --write` on the two
   files fixed it instantly, but it's still a ~15s edit-and-lint stage that a
   `prettier --write` pass right after editing those two files would have
   skipped.

Both of the above are "one extra `pnpm verify` round-trip" costs (~15–20s
each locally, more over CI), not correctness problems — nothing was
re-designed because of them.

## What should change in `.agentic/material/`

- **A short "verify order-of-operations" note**: run `pnpm generate` (if the
  OpenAPI contract changed), immediately `git add` the contract file *and*
  the regenerated file together, then `prettier --write` every file you
  touched, *then* run `pnpm verify` for the first time. This would have
  collapsed three `pnpm verify` round-trips on this mission into one.
- **A short "ineligibility/status taxonomy" note for `apps/engine/src/projects/`**:
  a one-paragraph map of which Slot-eligibility concepts are structurally
  modeled today (capability presence/absence via `ProjectSlotRequirement.requires`
  and each Module's `capabilities.requires[].binding`) versus which are not
  (there is no per-Slot expected resource `kind`; `kind` only participates
  in eligibility via an *existing* Local Binding's own recorded `kind` for
  its `ref`). A future ticket that assumes "kind" is a first-class, always
  reachable eligibility axis will hit the same research detour this mission
  did.
