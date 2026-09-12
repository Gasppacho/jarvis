# ADR 0016 — Reconcile Workspaces before the engine is ready

**Status:** Accepted
**Date:** 2026-09-08

Jarvis reconciles Workspace Leases, workspace directories and Git worktree records immediately after SQLite migrations and before the engine announces `ready`. This deterministic pass prevents a crashed engine from accumulating disk or Git state; periodic retention work and user-facing health reporting remain separate concerns.

Startup alone does not establish that every lease owner is dead. An unexpired
active lease whose recorded owner process is still alive keeps its Workspace
and occupies its project's capacity. Unknown or dead owners and expired leases
follow the existing cleanup policy. An inaccessible process is conservatively
treated as alive; a missing process is not. This preserves the admission
exclusivity required by #194 when another owner is still working.
