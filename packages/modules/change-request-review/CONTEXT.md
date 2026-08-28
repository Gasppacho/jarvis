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
