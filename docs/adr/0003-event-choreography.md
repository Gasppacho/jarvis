# ADR 0003 — Event choreography instead of a central workflow

**Status:** Accepted  
**Date:** 2026-08-28

Business flow emerges from active module subscriptions. The Kernel persists and routes events but does not encode the development workflow. Each module execution completes locally and emits outputs; a later external fact starts a new execution rather than resuming a suspended global loop. This makes modules independently replaceable and composable.

## Amendment — L14 (#234)

The choreography remains event driven, but the product's current guided
composition is fixed to GitHub and Development. Development owns the admission
predicate and emits its self-targeted implementation Request after a verified
GitHub observation. Historical Automation Rules configuration is retained only
for migration, export and audit; it is not a catalog option or an executable
consumer. The original decision and its historical examples remain unchanged.
