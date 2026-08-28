# ADR 0010 — Portable project config and local bindings

**Status:** Accepted  
**Date:** 2026-08-28

Shareable composition lives in committed `.jarvis/project.yaml`; machine paths, security bookmarks, concrete connection IDs and runtime IDs live in local bindings. Secrets live only in Keychain. This lets a project express its ecosystem without leaking machine-specific or sensitive data.
