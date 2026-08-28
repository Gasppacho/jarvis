# Local Development

## Host requirements

Development machine:

- supported macOS on Apple Silicon;
- current Xcode compatible with the deployment target;
- Node.js 24 LTS for repository development only;
- pnpm via Corepack;
- Git;
- optional `gh` and Codex CLI for real-adapter tickets.

The shipped application still bundles its own Node runtime.

## Intended root commands

Ticket 01 must make these commands real and keep them stable:

```bash
pnpm install
pnpm generate          # contracts and clients
pnpm contracts:check   # schemas, examples, manifests and OpenAPI
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build:engine
pnpm verify             # all non-release gates
```

macOS commands:

```bash
xcodebuild -scheme Jarvis -configuration Debug build
xcodebuild -scheme Jarvis test
```

A helper such as `scripts/run-dev-app.sh` may build/copy the Engine resources and launch the Xcode app. It must not become a production runtime prerequisite.

## Recommended development loop

1. Open a fresh branch/worktree for one ticket.
2. Run `/implement <ticket>`.
3. Start at the ticket's primary seam with `/tdd`.
4. Run the smallest failing test repeatedly.
5. Run `pnpm typecheck` and Swift build regularly.
6. Run `pnpm verify` and Xcode tests at completion.
7. Run `/code-review` and fix blockers.
8. Commit.

## Local data

Development builds must support an isolated data root:

```bash
JARVIS_DATA_ROOT=/tmp/jarvis-dev-<id>
```

Tests never use the developer's real Application Support directory, Keychain items, repositories or GitHub account unless explicitly marked sandbox/manual.

## Engine-only development

The Engine can run from a terminal for tests and debugging, but this is not the product experience. It still requires a generated token and loopback bind. Production code must not add an unauthenticated `--dev-open-api` mode.

## Contract changes

When changing a schema or OpenAPI:

1. update the source file;
2. update examples;
3. regenerate clients/types;
4. run compatibility tests;
5. update event catalog/contract doc;
6. add an ADR only if the semantic decision is durable and surprising.

## External integration tests

Real GitHub/Codex tests are opt-in and use dedicated sandbox resources. They are never part of the fast default TDD loop and never reuse a production/client repository.
