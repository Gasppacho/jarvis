# Risk Register

| Risk | Likelihood | Impact | Mitigation / test |
|---|---:|---:|---|
| Packaging Node and native SQLite addon breaks code signing | Medium | High | Build early in ticket 01, smoke-test nested signing, pin ABI/runtime |
| GUI app cannot find user CLIs/PATH | High | Medium | Runtime Detector resolves absolute paths via controlled login shell and persists descriptors |
| Prompt injection causes unauthorized side effect | Medium | Critical | Project capability grants, provider side effects only through requests, tool allowlists, untrusted-content prompt policy |
| Event choreography becomes invisible spaghetti | Medium | High | Contract Registry, emergent graph, correlation/causation timeline, request uniqueness validation |
| At-least-once delivery duplicates PR | Medium | High | Stable idempotency key, external mapping, lookup-after-crash tests |
| SQLite lock contention with long agent runs | Medium | Medium | No long transaction around processes/network; WAL; short claim/complete transactions |
| Worktree leaks consume disk | Medium | Medium | Durable leases, startup reconciler, retention job and UI health warning |
| Project commands are unsafe | Medium | High | Commands come only from validated project config; no event-supplied shell; explicit display and timeout |
| External CLI output changes | High | Medium | Adapter-specific parsing, structured mode when available, version detection and contract tests |
| GitHub polling misses or repeats labels | Medium | Medium | Cursor overlap window, external event IDs, logical dedupe and periodic reconciliation |
| Scope expands to marketplace/multi-machine too early | High | High | Out-of-scope list, bundled modules ADR, MVP acceptance gate |
| Swift and TypeScript API drift | Medium | High | OpenAPI source of truth, generated clients and CI diff gate |
| Documentation overload harms agents | Medium | Medium | Short AGENTS pointers, context map, one owner per fact, glossary-only CONTEXT files |
| Cross-project data leak in shared SQLite | Low | Critical | Mandatory ProjectContext, repository APIs scoped by project, adversarial tests |
| Direct distribution alarms Gatekeeper | Medium | High | Developer ID, hardened runtime, notarization and clean-machine test |
