# Context: Development

## Terms

### Implementation Request
A request to implement one canonical Work Item in one repository.

### Work Item
The provider-neutral unit of requested product or engineering work.

_Avoid_: GitHub Issue, Jira ticket in the domain model.

### Observed Work Item State
A provider fact describing the current state, tags and dependencies of a Work
Item. It is evidence for a later admission decision; it does not request or
start an Implementation.

In fixed mode, Development owns that decision: its pure predicate checks the
verified observation against the project label, scope, repository binding and
durable admission identity, then emits one targeted Implementation Request.

### Implementation
The local attempt that transforms a Work Item into a pushed branch.

_Avoid_: Pull Request; that resource is created later by an SCM provider.

### Admission
The project-scoped decision that allows a waiting Implementation Request to
start Development once capacity and current Work Item eligibility permit it.

### Admission Suspension
A durable pause of new Development starts for one project. Running work and
its Change Request creation continue; this is distinct from Cancellation.

### Worktree Preparation
The package-manager install selected from the repository lockfile, or no command
when no supported lockfile is present. It runs once after workspace allocation
and before the first agent start. Durable checkpoints prevent a recovered
execution from running it twice.

### Pushed Change
A branch and commit successfully present on the GitHub remote discovered from
the worktree. `origin` is preferred; otherwise exactly one GitHub remote is
required.

### Implementation Result
The terminal domain outcome: completed, failed or cancelled.

### Change Request Creation Request
The provider-neutral request emitted after a Pushed Change is ready for review.
