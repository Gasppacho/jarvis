# ADR 0012 — GitHub polling as the initial inbound adapter

**Status:** Accepted  
**Date:** 2026-08-28

The first GitHub module observes labels and relevant state through a project-scoped polling adapter with a durable cursor. This avoids requiring a public webhook endpoint for a local application. The provider port remains adapter-neutral so a webhook or local relay can be added later without changing canonical events or downstream modules.
