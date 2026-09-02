# MISSION-0004 Retro

## What worked

- Local merge ancestry correctly selected #40 after both #38 and #39, without trusting stale labels or deliberately open issue states.
- A single Engine-owned composition review response kept routing, compatibility, validation, capability, and binding policy out of SwiftUI.
- TDD found two important gaps: the missing review route and the inability to save/reopen the canonical empty Project Draft.
- The second full-suite pass caught an older presentation test that still treated Event choices as readiness; updating it enforced the new Engine-owned boundary.
- Application Harness and XCTest covered the slice without filesystem or SQLite mocks, and the packaged app built successfully.
- Manual two-axis review found and fixed omitted unknown-Event rows and incorrect fresh-Draft readiness before commit.

## What to improve

- `pnpm generate:check` compares generated output against the unstaged worktree, so generated files must be staged before the pre-commit full gate. The mission material should state this explicitly.
- Running Engine integration tests and Swift tests concurrently can race on the shared `dist/engine` bundle. Focused checks should run sequentially when both launch/rebuild the Engine.
- `ProjectDetailView.swift` and `ProjectDetailPresentation.swift` are now large. A future, separately scoped refactor could extract Review-only presentation/rendering without moving Engine policy into UI code.
- The `implement` slash command was not exposed in this environment. The documented fallback worked, but local installation would make sequencing and evidence capture less manual.
- Child issues intentionally remain open, so reruns must continue to use local merge ancestry and explicit blocker edges rather than labels or issue state.
