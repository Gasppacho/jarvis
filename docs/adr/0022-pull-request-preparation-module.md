# ADR 0022 — Prepare Change Requests in a dedicated module

- **Status:** Accepted
- **Date:** 2026-09-23

## Decision

Development emits only `development.implementation.completed` after its branch
and commit are pushed. A separate Pull Request module consumes that fact,
retrieves the Work Item and commit diff in its own workspace, and prepares the
Change Request title and description. It publishes
`scm.change-request.creation-requested` to the project SCM provider.

The GitHub module remains responsible for the idempotent GitHub API call and
for publishing creation success or failure. Review and merge remain separate
workflow actions. The fixed GitHub Development starting point includes all
three modules. Existing fixed GitHub and Development projects can add Pull
Request from the Workflow module catalog. Pre-fixed GitHub, Automation Rules
and Development projects receive it when the user applies the guided migration.

For GitHub, Pull Request reads the current `default_branch` through its
project-bound API connection, targets that branch, and adds `Closes #N` to the
description. The local checkout branch is not authoritative for the target.

## Consequences

- Development no longer owns Change Request metadata or emits its creation
  request.
- Pull Request preparation failures are visible and retryable without creating
  an external Pull Request.
- The provider retains idempotency for the external side effect.
- Completion facts and creation requests remain project-scoped and independently
  consumable through the event contract.
