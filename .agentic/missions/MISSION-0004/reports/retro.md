# MISSION-0004 Retro

## What worked

- Integrating the leftover green #34 branch before selecting #35 preserved the dependency chain and produced a verified `main` baseline.
- Treating #35 as a deliberate throwaway-prototype ticket prevented prototype SwiftUI from leaking into the production app.
- The shared Fresh, Valid, Orphaned, and Ambiguous fixtures made the three structural grammars comparable rather than cosmetic variants.
- A plain-value presentation/action/accessibility inventory matched the existing macOS test seam and made red/green evidence fast and deterministic.
- Recording the comparison in `docs/product/UX.md` leaves later tickets one clear grammar without an unnecessary ADR.
- The packaged app and full verification gate ran successfully, including all Engine integration and Swift tests.

## What to improve

- The mission handoff should distinguish temporary prototype-build evidence from retained XCTest evidence more explicitly; prototype source is intentionally absent from the final diff.
- The code-review skill assumes committed `HEAD` versus a fixed point, while this workflow requires review before commit. The mission material should prescribe a working-tree equivalent (`git diff main`) for that ordering.
- The local-completion frontier rule should remain prominent because GitHub issues intentionally stay open and labels therefore cannot represent progress.
- Future runs should continue integrating any completed branch before creating the next one; otherwise locally satisfied blockers can appear unresolved.
