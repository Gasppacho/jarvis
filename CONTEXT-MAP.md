# Jarvis Context Map

Jarvis is a multi-context repository. Read this map first, then open only the glossary for contexts touched by the current task.

| Context | Glossary | Responsibility | Upstream / downstream relationship |
|---|---|---|---|
| macOS Shell | [`apps/macos/CONTEXT.md`](apps/macos/CONTEXT.md) | Native user experience and supervision of the embedded engine | Consumes the Local API; never owns engine business behavior |
| Kernel | [`packages/kernel/CONTEXT.md`](packages/kernel/CONTEXT.md) | Hosts projects and module instances; enforces global runtime invariants | Coordinates shared primitives without knowing module business semantics |
| Eventing | [`packages/eventing/CONTEXT.md`](packages/eventing/CONTEXT.md) | Durable event publication, routing and delivery | Used by every module through the Module SDK |
| Project Runtime | [`packages/project-runtime/CONTEXT.md`](packages/project-runtime/CONTEXT.md) | Loads one project's composition and isolates its resources | Binds global candidates to project-scoped slots |
| Module SDK | [`packages/module-sdk/CONTEXT.md`](packages/module-sdk/CONTEXT.md) | Stable authoring contract for executable modules | Boundary between Kernel primitives and module implementations |
| Agent Runtime | [`packages/agent-runtime/CONTEXT.md`](packages/agent-runtime/CONTEXT.md) | Executes project-bound coding agents and MCP clients | Invoked by agentic modules; does not decide business workflow |
| Workspace | [`packages/workspace/CONTEXT.md`](packages/workspace/CONTEXT.md) | Allocates isolated Git worktrees and leases | Used by development-like modules |
| GitHub Integration | [`packages/modules/github/CONTEXT.md`](packages/modules/github/CONTEXT.md) | Translates GitHub facts/actions to canonical SCM events | Provider context; upstream and downstream of the Event Bus |
| Automation Rules | [`packages/modules/automation-rules/CONTEXT.md`](packages/modules/automation-rules/CONTEXT.md) | Maps facts to requested work using project rules | Consumes facts and emits requests; owns no external provider |
| Development | [`packages/modules/development/CONTEXT.md`](packages/modules/development/CONTEXT.md) | Implements a ticket and publishes a pushed branch | Consumes implementation requests; asks the SCM provider to create a Change Request |
| Change Request Review | [`packages/modules/change-request-review/CONTEXT.md`](packages/modules/change-request-review/CONTEXT.md) | Reviews a created Change Request | Optional downstream module; emits review publication requests |

## Relationship rules

- Contexts may share identifiers and technical primitives defined by the shared kernel, never another context's aggregates or repositories.
- Provider contexts translate external concepts at their boundary. Other contexts use canonical terms such as **Work Item** and **Change Request**.
- Project Runtime is the composition root. Module packages are global code; module instances and bindings are project-scoped.
- Eventing is transport semantics, not workflow semantics. Workflow emerges from active subscriptions inside a project.
