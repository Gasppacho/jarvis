# Context: Development

## Terms

### Implementation Request
A request to implement one canonical Work Item in one repository.

### Work Item
The provider-neutral unit of requested product or engineering work.

_Avoid_: GitHub Issue, Jira ticket in the domain model.

### Implementation
The local attempt that transforms a Work Item into a validated pushed branch.

_Avoid_: Pull Request; that resource is created later by an SCM provider.

### Validation Plan
The ordered project commands that determine whether the change is acceptable.

### Repair Cycle
A bounded additional Agent Run using validation failure context.

### Pushed Change
A branch and commit successfully present on the configured remote.

### Implementation Result
The terminal domain outcome: completed, failed or cancelled.

### Change Request Creation Request
The provider-neutral request emitted after a Pushed Change is ready for review.
