# MISSION-0017 — Acceptance checklist (#51)

## Ticket criteria

- [ ] The Wizard exposes a list representation of the composition built only from the read model of #49; the UI contains no engine business rules.
- [ ] Module Instances, produced and consumed events, slots, bindings and required capabilities are each clearly distinguished.
- [ ] Resolved requests, orphan requests, ambiguous consumers, missing bindings, missing capabilities, incompatible contracts and disabled modules each read as a distinct state named in text, never by colour alone.
- [ ] Each row names its stable identifier, contract version, routing status and the applicable validation findings.
- [ ] Keyboard and VoiceOver order is stable and follows the read model order.
- [ ] XCTest asserts the mapping from read model to list rows for valid, incomplete and ambiguous compositions.

## Mission gates

- [ ] The shipped list matches the hierarchical outline recorded in `docs/product/UX.md` by #50.
- [ ] Row ids are unique across the whole list, asserted by test.
- [ ] GUI session checked with `ioreg` **before** building; result stated in the report.
- [ ] Screenshots captured into `reports/`, showing a resolved route and a failing one, each state readable in text.
- [ ] No capture carries personal information or another app's content.
- [ ] No file under `apps/engine/**`, `packages/**` or `contracts/**` changed.
- [ ] No GitHub issue created, edited, labelled, commented on or closed.
- [ ] `pnpm verify` passes on the branch, each stage reported with its actual result.
- [ ] Staged by explicit paths; no `git add -A`.
- [ ] Merged `--no-ff` into `main`, `pnpm verify` re-run on merged `main`, pushed as a plain fast-forward, `origin/main` confirmed equal to local `main`.
- [ ] `reports/review-report.md` and `reports/retro.md` written.
