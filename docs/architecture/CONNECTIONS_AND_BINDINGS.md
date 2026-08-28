# Connections, MCP and Bindings

## Global candidates, project authority

Jarvis may discover or store reusable descriptors globally, but authority is granted only through a Project Binding.

```text
Global Registry                  Project token-warehouse
──────────────────               ───────────────────────
connection/github-work ─────────► slot sourceControl
mcp/github-work ────────────────► slot tickets
runtime/codex-default ──────────► slot agentRuntime
connection/gitlab-client         not visible
```

A registry list is never passed to a module or agent.

## Connection descriptor

A descriptor contains provider, account label, capabilities, status and `secretRef`. It does not contain the secret value. Typical capabilities:

```text
github.api
scm.change-request.manage
work-items.read
```

The provider adapter resolves credentials at call time from Keychain.

## MCP descriptor

An MCP descriptor records transport, server identity, available tools/resources and auth status. A binding may expose a filtered capability subset to an Agent Run. The Project does not automatically expose all tools advertised by the MCP server.

## Runtime descriptor

An Agent Runtime descriptor records executable path, provider, version, authentication state and normalized capabilities. Executable discovery is machine-local and never stored in `.jarvis/project.yaml`.

## Bindings

Portable slots express requirements. Local bindings resolve them. A Module Instance can map one of its named bindings to a Project slot:

```yaml
modules:
  - instanceId: development
    bindings:
      tickets: tickets
      repository: main
      sourceControl: sourceControl
    runtimeSlot: agentRuntime
```

The resolved Module Context receives only these objects.

## Read access versus external mutation

A coding agent may use a project-bound MCP to read Work Item context. External mutations remain owned by modules and Events. For the MVP:

- Git branch/commit/push are local Git responsibilities of Development.
- Pull Request creation is a GitHub Module responsibility after a Request.
- Merge is unavailable because no MVP Module may emit its Request.

Technical availability of a tool does not transfer domain ownership.

## Lifecycle

```text
Discovered → Configured → Available
                    ↘ Unauthenticated / Unavailable / Revoked
```

A status change triggers Project revalidation. Active paths requiring the resource become degraded; unrelated paths continue.

## Suggested MVP adapters

- GitHub connection backed by existing authenticated `gh` CLI or a Keychain token adapter.
- GitHub MCP as an optional project-bound read capability.
- Codex CLI runtime detected by absolute executable path.
- Engine capabilities for Git, filesystem and controlled project commands.

The adapter chosen may evolve; the slot and capability names are the stable contract.
