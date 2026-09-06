# MISSION-0022 — Execution plan

## 0. Preconditions

- `git status --short` shows only untracked `.agentic/` and `.jarvis/` material.
- **Create the branch first**: `git checkout -b agent/47-resource-eligibility-reasons` from `main`.

## 1. The ADR

The decision is made; the ADR records it. Next free number under `docs/adr/`, existing format. It must state:

- the decision: granted-but-ineligible resources are named with the Engine's reason; non-granted resources stay completely invisible;
- the threat boundary: a project must never be able to read the global inventory belonging to other projects — invariant 2;
- what was rejected and why: an anonymous count or aggregate for non-granted resources, because cardinality is still a leak across the project boundary;
- the compatibility and versioning consequences for `PROJECT_CONFIG_V1` and the Local API.

## 2. Analysis

Find where the grant filter is applied today and which ineligible cases it drops. The decision permits surfacing only those already inside the project's authority.

## 3. Implementation

Extend `ProjectResourceChoices` / `ProjectResourceBindingChoice` and the `binding-candidates` surface. The Engine computes eligibility and the reason; the client reproduces nothing. Every wire addition is optional. Contracts, docs, examples and the generated client move together.

## 4. Tests

Application Harness with real project-scoped grants: eligible resource, each permitted ineligible case, and a resource granted to another Project proven absent in every form. Generated-client decoding asserted. Deterministic, ordered by Slot.

## 5. Verification and integration

`pnpm verify` in full — background, bounded poll, never `tail -f`. No UI ships, so no screenshot gate.

Then commit on the branch (no auto-close keyword), `--no-ff` merge, verify again on merged `main`, plain fast-forward push, two reports committed alongside the code.

## Context budget

- Do not read other missions' material.
- Do not read `node_modules/`, `dist/`, `apps/macos/.build/`.
- No `git log -p`, no large `git diff`.
