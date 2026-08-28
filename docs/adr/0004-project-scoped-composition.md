# ADR 0004 — Project-scoped composition root

**Status:** Accepted  
**Date:** 2026-08-28

Every project's modules, connections, MCP, runtimes, commands, repositories and rules are composed independently. Global registries store available resources only; a project binding grants access. All events and executions carry `projectId`, and cross-project delivery is forbidden.
