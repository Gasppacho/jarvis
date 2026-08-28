# ADR 0003 — Event choreography instead of a central workflow

**Status:** Accepted  
**Date:** 2026-08-28

Business flow emerges from active module subscriptions. The Kernel persists and routes events but does not encode the development workflow. Each module execution completes locally and emits outputs; a later external fact starts a new execution rather than resuming a suspended global loop. This makes modules independently replaceable and composable.
