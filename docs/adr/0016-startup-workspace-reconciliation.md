# ADR 0016 — Reconcile Workspaces before the engine is ready

**Status:** Accepted  
**Date:** 2026-09-08

Jarvis reconciles Workspace Leases, workspace directories and Git worktree records immediately after SQLite migrations and before the engine announces `ready`. Startup is the only reliable owner-death boundary, so this deterministic pass prevents a crashed engine from accumulating disk or Git state; periodic retention work and user-facing health reporting remain separate concerns.
