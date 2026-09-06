# MISSION-0022 — Expose Engine-owned resource eligibility reasons (#47)

## User request

Implement ticket **#47**, a child of #5, with a Sonnet execution team. One mission only.

## The blocking decision — already made, do not re-open it

#47 could not start until a product and security decision was recorded. **The repository owner made it on 2026-09-06:**

> **Disclose granted-but-ineligible resources only.** A resource already granted to the Project but ineligible — a missing capability, a wrong `kind`, a partial capability match — is named and explained with the Engine's reason. A resource **not granted** to the Project stays **completely invisible**: not named, not counted, not hinted at.

The rationale to record in the ADR: this buys the whole UX gain — no silently empty picker — while leaving invariant 2 intact. Global registries only expose candidates; a project must never be able to read the global inventory of connections, runtimes or repositories belonging to other projects. Disclosing a count or an anonymous aggregate was considered and rejected: cardinality is still a leak across the project boundary.

Your job is to implement that decision and record it, not to revisit it.

## Objective

Expose Engine-owned resource eligibility and its reason as one independently verifiable tracer bullet: record the ADR, version the contract, compute the result in the Engine, return it from the Local API, regenerate the Swift client, and prove the behaviour through the Application Harness.

This is the documented foundational Local API tracer-bullet exception to a UI-complete vertical slice. **It ends at a generated-client integration proof and adds no Project Slot UI.**

## Mission type

small-feature

## Complexity

M

## Expected behavior

- An ADR under `docs/adr/` records the disclosure decision: the rationale, the threat boundary, and the compatibility/versioning consequences. It supersedes the blanket rule in `docs/contracts/PROJECT_CONFIG_V1.md` only to the extent the decision allows.
- The versioned machine-readable contract represents a permitted ineligible resource together with an Engine-owned reason, without weakening project scoping.
- The **Engine is the sole authority** that computes eligibility and reasons. Clients reproduce none of those rules.
- A resource not granted to the Project appears nowhere in the response — no entry, no identifier, no count, no placeholder.
- The Local API and the regenerated Swift client expose the versioned result consistently.
- Application Harness tests prove an eligible resource, each permitted ineligible case, and that forbidden resources remain undisclosed.
- Contract documentation, examples, generated artifacts and compatibility tests change together.

## Non-goals

- **No Project Slot UI, no SwiftUI view, no presentation model.** The slice ends at the generated-client proof. A later ticket consumes it.
- No change to what the validator considers valid.
- No composition map (#28), no runtime graph (#18), no split-view migration (#5).
- No disclosure of non-granted resources in any form, including counts, hashes, ordering hints or timing differences.

## Constraints

- `AGENTS.md` is authoritative: strict TypeScript, no `any`, no cross-context database access.
- Invariant 2 is the point of this ticket: configuration is project-scoped; global registries only expose candidates a project may use.
- Invariant 12: OpenAPI, JSON Schemas, examples, `docs/contracts/PROJECT_CONFIG_V1.md`, `docs/contracts/LOCAL_API_V1.md` and tests change together. `pnpm generate` refreshes `apps/engine/src/api/generated`; never hand-edit a generated file.
- **A wire schema addition must be optional, not required.** MISSION-0019 added a required field to a published schema and broke 9 Swift fixtures with `DecodingError.keyNotFound`. The Swift client is regenerated here, but hand-written test fixtures under `apps/macos/JarvisAppTests` still decode these shapes.
- The existing surfaces are `GET`/`POST /v1/projects/{projectId}/binding-candidates` and the `ProjectResourceChoices` / `ProjectResourceBindingChoice` schemas. Extend those rather than inventing a parallel path.
- Highest realistic seam: the Application Harness in `apps/engine/test/` with real project-scoped grants and resources.

## Allowed scope

- `docs/adr/` — the new ADR
- `packages/project-runtime/src/`, `packages/kernel/src/` as required
- `apps/engine/src/projects/`
- `contracts/openapi/`, `contracts/schemas/`
- `apps/engine/test/`
- `docs/contracts/PROJECT_CONFIG_V1.md`, `docs/contracts/LOCAL_API_V1.md`, `docs/architecture/PROJECTS.md`
- `apps/macos/JarvisAPI/` only if regeneration touches it; **no Swift UI or presentation code**
- `.agentic/missions/MISSION-0022/`

## Disallowed changes

- Any SwiftUI view, presentation model or Swift test beyond what regeneration forces.
- Any GitHub issue: create, edit, label, comment on or close **none**. No commit message may carry a `Fixes`/`Closes`/`Resolves` keyword.
- `git reset --hard`, `git clean -fd`, `git add -A`, `git add .`, `git push --force`, `rm -rf`.

## Acceptance criteria

Every checkbox in `acceptance-checklist.md`, which mirrors #47.

## Stop conditions

Stop and report rather than guessing when:

- honouring the decision would require weakening project scoping anywhere;
- a non-granted resource cannot be kept out of the response without restructuring a contract outside the allowed scope;
- `generate:check` or `contracts:check` cannot pass within scope;
- the working tree carries changes this mission did not make;
- any acceptance criterion is unreachable.

## Expected reports

- `.agentic/missions/MISSION-0022/reports/review-report.md`
- `.agentic/missions/MISSION-0022/reports/retro.md`
