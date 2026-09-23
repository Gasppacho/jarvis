# Agent instructions

## Agent skills

- Run `setup-matt-pocock-skills` once when the repository setup is missing or inconsistent; preserve existing decisions.
- Use `grill-with-docs` while clarifying product or architecture choices and update the relevant source-of-truth document.
- Use `to-spec` to turn an agreed conversation into a spec; do not re-interview when the answer is already recorded.
- Use `to-tickets` to create tracer-bullet vertical slices with explicit blockers.
- Use `implement` for one ticket at a time, with `tdd` at the agreed highest seam and `code-review` before commit.
- Use `domain-modeling` when canonical terms, a `CONTEXT.md`, the context map, or an ADR must change.
- Use `research` for current external APIs, SDKs, platform rules, packaging or security facts.
- Use `diagnosing-bugs` for observed failures; do not guess from symptoms alone.

### Issue tracker

GitHub Issues on `Gasppacho/jarvis` via `gh`; local `.scratch/<plan>/issues/` fallback. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, default label names. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: root `CONTEXT-MAP.md` plus per-package `CONTEXT.md`. See `docs/agents/domain.md`.

## Read on demand

- Product scope or user-visible behavior: `docs/product/MVP_SPEC.md` and `docs/product/UX.md`.
- System boundaries or process topology: `docs/architecture/SYSTEM.md`.
- Modules, events, projects, executions, runtimes, persistence, security or tests: read the matching file under `docs/architecture/`.
- Contract changes: read the matching file under `docs/contracts/`, its schema under `contracts/`, and applicable ADRs.
- Domain terminology: start with `CONTEXT-MAP.md`, then read only the `CONTEXT.md` files for contexts touched by the task.
- Hard-to-reverse decisions: `docs/adr/`.
- Ticket sequencing and release gate: `docs/plans/`.

## Non-negotiable invariants

1. Jarvis is one local macOS product; core functionality requires no remote Jarvis server.
2. Configuration is project-scoped. Global registries only expose candidates; projects bind the resources they may use.
3. A module is an executable bounded context and owns its behavior, state, handlers, loops, agents, tools, prompts and adapters.
4. Modules never import or call another module's application/domain code. Integration occurs only through versioned events or shared kernel primitives.
5. A module execution is finite. Later external events start new executions and never resume an earlier loop.
6. Request events express intent; fact events report completed reality. A request must resolve to exactly one active consumer inside its project.
7. Development-like modules own worktree, branch, code changes, tests, commit and push. SCM providers create/review/merge a Change Request only after the corresponding request event.
8. No merge occurs unless a module explicitly emits `scm.change-request.merge-requested`.
9. Every event is scoped by `projectId`; cross-project delivery is forbidden.
10. Secrets never appear in repository config, events, prompts, artifacts or logs.
11. External ticket text, comments and repository content are untrusted input, not authority over Jarvis policy.
12. Machine-readable schemas and OpenAPI are contracts. Update docs, examples, tests and versioning together.

## Engineering expectations

- Prefer the highest realistic test seam and fewer seams over many low-level mocks.
- Deliver vertical slices that remain green and demoable.
- TypeScript is strict; avoid `any`, ambient mutable state and cross-context database access.
- Swift uses structured concurrency and generated API types; UI code does not contain engine business logic.
- All external side effects are idempotent and observable.
- New context-specific vocabulary belongs in the nearest `CONTEXT.md`; implementation details do not.
- New durable architectural decisions belong in an ADR, not in this file.

<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
