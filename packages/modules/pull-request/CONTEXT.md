# Context: Pull Request

## Terms

### Implementation Completion
The Development fact that a Work Item's branch and commit were pushed to the
repository remote.

### Pull Request Preparation
The finite work that turns an Implementation Completion, its Work Item and its
commit diff into a Change Request title and description.

### Change Request Creation Request
The provider-neutral request that asks the project's SCM provider to create a
Change Request from the prepared title, description, base branch and pushed
branch. Preparing the request does not create the external resource.

### Issue Closing Reference
The `Closes #N` GitHub keyword added to the description. Pull Request targets
the repository's current default branch, read through its project-bound API
connection; the local checkout branch is not the source of truth.
