# MISSION-0017 — List the composition in Project Wizard (#51)

## User request

Implement ticket **#51**, the third slice of #28, with a Sonnet execution team. One mission only.

## Objective

Give the Project Wizard a complete text/list representation of the configured composition, driven by the composition graph read model from #49 and shaped by the representation #50 retained: the **hierarchical outline**.

This is the accessible, deterministically assertable form of the map. It exists on its own now, before any drawn view, and stays the equivalent alternative once #52 draws the map.

## Mission type

small-feature

## Complexity

M

## Expected behavior

- The Wizard exposes a list of the composition built only from `POST /v1/projects/{projectId}/composition-graph` (`ProjectCompositionGraphV1`). No engine business rule is reimplemented in Swift: consumers, compatibility and routing come from the response as-is.
- Shape retained by #50 and recorded in `docs/product/UX.md` → "Graphe émergent" → "Représentation retenue": each Module Instance is a parent row; its produced and consumed contracts and its required capabilities are child rows; the routing status is carried by the child row itself, with no cross-referencing needed to read it.
- Module Instances, produced and consumed events, slots, bindings and required capabilities are each clearly distinguished.
- Every state reads as text plus an icon, **never colour alone**: `Resolved → <consumer>`, `Broadcast → <consumer>`, `Orphaned — no consumer`, `Ambiguous — <candidates>`, a `Disabled` badge, an incompatible contract, and the rail's `bound` / `unresolved` / `unbound`.
- Each row names its stable identifier, contract version, routing status and the applicable validation findings.
- Keyboard and VoiceOver order is stable and follows the read model order.

## Non-goals

- No drawn map, no cards, no edges, no canvas. #52 owns that.
- No engine, contract or generated-client change. #49 shipped the read model; it is fixed.
- No activation work (#53–#55), no runtime/execution visibility (#18).
- No new validation rule and no change to what the validator considers valid.

## Constraints

- `AGENTS.md` is authoritative. Swift uses structured concurrency and the generated API types; **UI code contains no engine business logic**.
- Follow the repo's existing seam: presentation logic lives in `apps/macos/JarvisCore/` (see `ProjectDetailPresentation.swift`) so it is testable without instantiating a `View`; `apps/macos/JarvisApp/Features/Projects/ProjectDetailView.swift` renders it.
- **Row identity must be unique.** MISSION-0016's outline prototype produced a duplicated row on the Ambiguous fixture because `List`/`ForEach` ids were not unique per Module Instance. Qualify every row id by Module Instance, role and index.
- The visual gate applies — this slice changes what the app displays. Check the GUI session **before** building: `.agentic/material/playbooks/visual-verification-gate.md`.
- `pnpm verify` must pass, on the branch and on merged `main`.

## Allowed scope

- `apps/macos/JarvisCore/`
- `apps/macos/JarvisApp/Features/Projects/`
- `apps/macos/JarvisAppTests/`
- `docs/product/UX.md` if the shipped list differs from what #50 recorded
- `.agentic/missions/MISSION-0017/`

## Disallowed changes

- `apps/engine/**`, `packages/**`, `contracts/**` — the read model is fixed. If it cannot express a required row, that is a stop condition, not a change to make here.
- Any GitHub issue: create, edit, label, comment on or close **none**. #49–#55 stay exactly as published.
- `git reset --hard`, `git clean -fd`, `git add -A`, `git add .`, `git push --force`, `rm -rf`.
- Unrelated refactors of surfaces this slice does not touch.

## Acceptance criteria

Every checkbox in `acceptance-checklist.md`, which mirrors #51.

## Stop conditions

Stop and report rather than guessing when:

- the GUI session is locked — do not build, launch or capture;
- the read model cannot express a row the ticket requires;
- a required state cannot be reached in the running app;
- the working tree carries changes this mission did not make;
- `pnpm verify` fails on a tree this mission did not break.

## Expected reports

- `.agentic/missions/MISSION-0017/reports/review-report.md`
- `.agentic/missions/MISSION-0017/reports/retro.md`
- the screenshots, in the same directory
