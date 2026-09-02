# MISSION-0004 Retro

## What worked

- Local merge history, rather than unchanged labels or deliberately open issues, identified #37 as the frontier.
- The existing project-scoped composition-choice tracer bullet supplied Event labels, compatibility, consumers, and routing explanations without adding UI routing policy.
- Standard JSON Schema `$comment` annotations let the Module Configuration schema select a specialized editor while retaining compatibility with strict schema validation and generic older editors.
- A dedicated XCTest file gave fast red/green feedback for canonical Rule decoding, repeatability, preservation, presentation metadata, unknown values, and readiness.
- Application Harness coverage proved semantic metadata transport, bounded-match validation, and canonical save/reopen against the real Engine and SQLite.

## What to improve

- `pnpm test:integration -- <file>` currently executes the complete integration project, not only the named file. The mission guidance should document the repository's actual Vitest filtering syntax or explicitly describe this as an intentionally broad focused gate.
- The composition-choice wire contract exposes Module Instance IDs but no independent human display label for Event producers/consumers. The shell currently derives a readable label from the instance ID; a future contract revision should consider returning display labels directly.
- `$comment` semantics are valid and backward-compatible but stringly typed. If more specialized editors appear, promote these annotations to a named, schema-validated contract rather than accumulating ad hoc comment values.
- #38 should consider extracting JSON normalization/structured-value handling shared by generic configuration fields and Automation Rules, without weakening invalid-input preservation.
