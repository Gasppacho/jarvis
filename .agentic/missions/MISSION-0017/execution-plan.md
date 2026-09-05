# MISSION-0017 — Execution plan

## 0. Preconditions

- `git status --short` shows only untracked `.agentic/` and `.jarvis/` material.
- `ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked` — locked means stop before building.
- Work on `agent/51-composition-list`, branched from `main`.

## 1. Analysis

The decision is already made; do not re-open it. `docs/product/UX.md` records the hierarchical outline and the exact state vocabulary. Read it first, then the read model, then how `ProjectDetailPresentation.swift` already turns an API response into testable rows.

## 2. Row model in JarvisCore

Pure mapping from `ProjectCompositionGraphV1` to rows:

- parent row per Module Instance — instance id, module package id, display name, enabled/disabled
- child row per produced contract, per consumed contract, per required capability
- each child carries contract id, version, direction, request-vs-fact, routing status and its text label, and the findings that apply
- rail entries for slots, bindings and capabilities with `bound` / `unresolved` / `unbound`
- every row id qualified by Module Instance, role and index — uniqueness is asserted by test

Swift recomputes nothing. Every status comes from the response.

## 3. Wizard rendering

Render the rows from `ProjectDetailView.swift`, in read model order, with a stable keyboard and VoiceOver path. State is icon **plus** text, never colour alone.

## 4. Tests

XCTest over the mapping for valid, incomplete and ambiguous compositions, plus row id uniqueness and row ordering.

## 5. Evidence and integration

Build, launch, capture a resolved route and a failing one. `pnpm verify` in full — run it in the background and poll a bounded loop; never `tail -f`, it never returns and stalls the run.

Then commit, `--no-ff` merge into `main`, verify again on merged `main`, plain fast-forward push, two reports.

## Context budget

- Do not read other missions' material.
- Do not read `node_modules/`, `dist/`, `apps/macos/.build/`.
- No `git log -p`, no large `git diff`.
