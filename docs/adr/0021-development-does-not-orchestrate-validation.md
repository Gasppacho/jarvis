# ADR 0021 — Development does not orchestrate validation commands

**Status:** Accepted
**Date:** 2026-09-21

Development owns the worktree, agent run, commit and push, but it does not launch a separate project validation plan or start repair runs from command failures. Verification belongs inside the agent's implementation task; keeping a second Jarvis-owned loop duplicated responsibility.

Worktree preparation is selected internally from the repository lockfile and remains durably checkpointed. Branch naming, push remote discovery, concurrency, retention, timeouts, output limits and runtime environment are also internal or local-binding policy. The Project and Development schemas reject their former configuration fields; migration 0039 removes them from saved configurations and active resolved snapshots. No compatibility reader remains.
