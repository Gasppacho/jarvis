# Context: Change Request Review

## Terms

### Change Request
The provider-neutral proposal to integrate a pushed source branch into a base branch.

_Avoid_: Pull Request or Merge Request in the domain model.

### Review Request
The fact-driven local decision to inspect one Change Request revision.

### Revision
The exact head commit reviewed.

### Review Finding
A structured issue with severity, location, rationale and suggested correction.

### Review Verdict
The module's conclusion for one Revision: approve, comment or request changes.

### Review Publication Request
The request asking the bound SCM provider to publish a Review Verdict.

### Stale Review
A review whose Revision no longer matches the Change Request head.

## MVP catalogue status

The official package is bundled in the MVP catalogue as an inactive composition candidate. Its
Manifest consumes `scm.change-request.created` and may require an Agent Runtime, but produces no
events until the reserved review-publication contracts become versioned. Activating handlers and
emitting a Review Publication Request remain post-MVP work; the catalogue must not invent those
contracts early.
