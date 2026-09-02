# MISSION-0004 Retro

## What worked

- Local merge history and the explicit mission work order selected #39 without relying on stale issue labels or open issue states.
- Starting from the existing candidate endpoint kept the slice vertical: OpenAPI → Engine policy → generated clients → Swift presentation.
- Computing one capability conjunction per Slot exposed a subtle existing bug: a candidate could satisfy the Slot while failing a Module Instance requirement routed through that Slot.
- A POST preview beside the saved GET lets Draft edits refresh resource guidance without persisting Portable Configuration or Local Bindings.
- Application Harness contract assertions and XCTest presentation inventory provided fast, realistic feedback before the full gate.
- The full macOS build and all Swift tests ran successfully in this environment.

## What to improve

- `generate:check` compares generated files with the index, so a legitimate generated change must be staged before the pre-commit full gate. The implement guidance should document this repository-specific requirement.
- The production Connection/MCP/Agent Runtime grant registry is intentionally empty. External explicit-grant and availability-transition policy therefore remains covered through the Project Service port, while the Application Harness covers selected Module Instances and the real HTTP/SQLite contract. Future registry tickets should add end-to-end Harness fixtures for those resource kinds.
- Repository requirements use the existing dedicated Repository Grant flow rather than Slot candidate pickers. A future contract could unify their read-only presentation metadata while keeping repository grants separate from generic `ProjectBindings.slots`.
- The resource status/repair construction in `ProjectService` is now substantial enough that a later change may justify extracting a Project Runtime domain service; this ticket kept it local to avoid unrelated prefactoring.
