# ADR 0009 — Direct Developer ID distribution

**Status:** Accepted  
**Date:** 2026-08-28

The MVP is distributed outside the Mac App Store as a Developer ID signed, hardened and notarized application. App Sandbox is not used because core behavior launches coding CLIs and accesses user-selected repositories and Git worktrees. Jarvis still enforces internal project bindings, capability grants and explicit folder consent.
