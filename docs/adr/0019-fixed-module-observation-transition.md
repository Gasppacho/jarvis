# ADR 0019 — Observation GitHub et transition vers les modules fixes

## Status

Accepted for the expand → migrate → remove transition described by parent issue #220.

## Context

The current GitHub inbound adapter mixes provider reading with readiness labels and
Automation Rules. The fixed-module composition needs a provider fact that remains
useful when no Development or Automation Rules Module is configured. Existing
legacy projects must continue to read and publish their historical label facts until
the later removal tickets.

## Decisions

- **D01 — Project composition:** a Project contains at most one instance of each
  Module Package. Adding a Module does not activate it or grant access. Links are
  calculated from contracts and project bindings; facts may have zero or many
  consumers, requests exactly one, and all delivery is scoped by `projectId`.
- **D02 — Provider observation:** GitHub publishes `scm.work-item.observed` v1.
  Its payload contains only the repository ID, bounded work-item title and ref,
  open/closed/unknown state, unique tags, complete or unknown dependencies,
  verification, a safe reason code, UTC observation time and a monotone revision.
  The provider owns reading and translation; it reads no rules. List and dependency
  pagination must complete, Pull Requests are excluded, and a disappeared tracked
  issue is re-read before a closed observation is emitted. Snapshot and Outbox
  publication commit atomically for `(projectId, repositoryId, workItemRef)`.
- **D03 — Development decision:** this tranche does not implement admission,
  predicates, labels or Development selection, and an observed fact never starts an
  agent by itself.
- **D04 — Configuration:** incomplete drafts remain saveable. Useful provider and
  Development settings keep their existing project-scoped bindings and bounded
  defaults; no generic workflow is introduced.
- **D05 — SCM outputs:** existing Change Request facts and requests remain the
  contract. Label mutations are a later explicit provider action and no automatic
  label change is added to the observation cycle.
- **D06 — Explicit transition:** `compositionMode: fixed-modules` is an optional
  portable v1 discriminant. Its absence means legacy. Fixed mode is never inferred
  from missing rules. Migration and removal happen in later expand → migrate →
  remove tickets, while legacy fixtures remain supported.

## Consequences

The GitHub Module can publish canonical state to a Project timeline with only its
own project binding. Development and Automation Rules are not required for this
observation path and receive no implicit request. The durable observation table is
separate from the legacy readiness admission table, so later consumers can adopt
the new fact without changing historical admission behavior.
