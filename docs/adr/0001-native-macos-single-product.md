# ADR 0001 — Native macOS single product

**Status:** Accepted  
**Date:** 2026-08-28

Jarvis is distributed and operated as one native macOS product on one machine. The user launches `Jarvis.app`; the app may supervise a separate embedded engine process, but installation, startup, update and shutdown remain one product concern. This preserves native UX and local execution without creating an external service to administer.
