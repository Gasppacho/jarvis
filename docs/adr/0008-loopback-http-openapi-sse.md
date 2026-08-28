# ADR 0008 — Loopback HTTP, OpenAPI and SSE

**Status:** Accepted  
**Date:** 2026-08-28

The shell and engine communicate through a bearer-protected HTTP API bound to loopback, described by OpenAPI 3.1, with SSE for live updates. A generated Swift client reduces contract drift. A Unix socket or XPC would increase integration cost without improving the MVP's user-visible behavior.
