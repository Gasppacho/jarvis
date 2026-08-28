# Capability Catalog v1

Capabilities name abstract authority or service; they are not implementation classes. IDs are lowercase dotted strings and may be used in Module Manifests and Project Slots.

## Engine capabilities

| ID | Meaning | Typical owner |
|---|---|---|
| `repository.read` | Read files and metadata in the bound repository/workspace | Workspace/Project Runtime |
| `repository.write` | Modify files inside the leased workspace | Workspace |
| `git.branch` | Create and inspect a working branch/worktree | Workspace/Git adapter |
| `git.commit` | Create a commit owned by the execution | Git adapter |
| `git.push` | Push the working branch to the configured remote | Git adapter |
| `shell.execute` | Run validated Project Commands in a workspace | Process adapter |
| `artifact.read` | Read a project-scoped Artifact reference | Artifact Store |
| `artifact.write` | Write a project-scoped Artifact | Artifact Store |

## Agent and context capabilities

| ID | Meaning |
|---|---|
| `agent.execute` | Start a session on the bound Agent Runtime |
| `mcp.invoke` | Invoke allowlisted tools/resources on one bound MCP descriptor |
| `work-items.read` | Read canonical Work Item details/comments through a bound source |

## SCM capabilities

| ID | Meaning |
|---|---|
| `scm.change-request.manage` | Provider can execute canonical Change Request requests it consumes |
| `scm.change-request.review` | Provider can publish canonical review requests |
| `scm.change-request.merge` | Provider can execute merge requests; not granted to MVP decision modules |
| `github.api` | Concrete GitHub adapter access, used only inside the GitHub context |

## Rules

- Modules request the narrowest capabilities required.
- Project Slots bind portable needs to local resources.
- A capability being available globally does not grant it to any Project.
- A Module Manifest declaration does not grant authority; the resolved grant is the intersection of manifest, Project Bindings and system security policy.
- New provider-neutral capability names are added here before use.
- Provider-specific IDs remain inside provider modules and should not appear in other module manifests.
