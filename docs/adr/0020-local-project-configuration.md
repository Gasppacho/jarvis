# ADR 0020 — Local project configuration

**Status:** Accepted
**Date:** 2026-09-19

Project configuration is stored only in Jarvis and is deleted with the Project;
Jarvis no longer reads or writes `.jarvis/project.yaml`. This supersedes ADR 0010
and the portable transition in ADR 0019: reimporting a deleted repository starts
with an empty workflow, while repository files remain untouched.

At adoption, existing Projects keep their repository grant but return to an empty
local Draft; historical portable or legacy composition is not migrated or restored.
Projects with a non-terminal Execution or Delivery are left unchanged so recovery can
finish against the exact snapshot that started the work; after completion they must be
deleted and reimported to adopt the empty local Draft.

The fixed Catalogue contains one GitHub Module and one Development Module. A Project
may activate either, both or neither. Verification checks only the selected GitHub
account's repository access and the selected agent CLI; disconnected events and an
empty label do not block activation. Development owns branch, command, validation,
concurrency, worktree and execution policy rather than exposing them as workflow
configuration. Development detects the repository's lockfile and Git remotes at
execution time; those technical choices are not user configuration.
