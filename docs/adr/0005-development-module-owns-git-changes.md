# ADR 0005 — Development-like modules own Git changes

**Status:** Superseded in part by ADR 0021
**Date:** 2026-08-28

A module performing code work owns its worktree, branch, file changes, validation, commit and push. The SCM provider only creates or mutates a canonical Change Request when it receives an explicit request event. This follows the available coding CLI workflow and keeps provider-specific APIs out of the development domain. ADR 0021 removes the separate Jarvis-owned validation and repair loop while preserving Development's remaining Git ownership.
