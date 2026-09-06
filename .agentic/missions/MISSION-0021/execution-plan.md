# MISSION-0021 — Execution plan

## 0. Preconditions

- `git status --short` shows only untracked `.agentic/` and `.jarvis/` material.
- `ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked` — locked means stop before building.
- **Create the branch first**: `git checkout -b agent/55-wizard-activate` from `main`.

## 1. Analysis

#45 already built the readiness signal and its vocabulary; #53 and #54 shipped the API. This slice wires them together. Establish how `compositionFingerprint` reaches the client from the displayed report, and how an engine error stays distinct from a validation finding in the existing presentation model.

## 2. The affordance

- Enabled only for the selected Project whose **current** report succeeded.
- Carries that exact report's fingerprint; refuses to activate without one.
- Every unavailable state explains itself in the existing readiness vocabulary.
- Any composition or Local Bindings edit revokes it immediately, through the same path that already marks the report stale.
- Success shows the Project active in the Wizard and the Project list.
- Rejection renders as a structured activation failure, never as a validation finding, leaving the displayed state consistent with the engine.

Swift decides nothing the engine decides. The client reflects and forwards.

## 3. Tests

XCTest over each affordance state, both revocation paths, the missing-fingerprint refusal, the success transition, and each rejection code plus a transport failure.

## 4. Evidence and integration

Capture Activate enabled, the Project active after success, and a rejection with its explanation. Use a disposable fixture Project.

`pnpm verify` in full — background, bounded poll, never `tail -f`. If a bare `pnpm <script>` call is rewritten into a nonexistent ESLint invocation by the repo hook, route it through `rtk proxy` as MISSION-0020 did.

Then commit (no auto-close keyword), `--no-ff` merge, verify again on merged `main`, plain fast-forward push, two reports committed alongside the code.

## Context budget

- Do not read other missions' material.
- Do not read `node_modules/`, `dist/`, `apps/macos/.build/`.
- No `git log -p`, no large `git diff`.
