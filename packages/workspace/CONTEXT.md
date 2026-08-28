# Context: Workspace

## Terms

### Workspace
An isolated filesystem checkout leased to one Module Execution.

_Avoid_: project, repository root.

### Worktree
The Git worktree implementation of a Workspace.

### Workspace Lease
The durable exclusive claim linking an Execution, repository, branch and path.

### Base Revision
The commit from which the Workspace branch is created.

### Working Branch
The branch owned by one Development-like execution.

### Cleanup Policy
The project rule deciding when a terminal Workspace is removed or retained.

### Workspace Leak
A path or Git worktree record left without a valid active or retained lease.
