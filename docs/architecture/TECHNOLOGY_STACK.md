# Technology Stack

## Principle

The versions below are baselines, not floating dependencies. Ticket 01 must pin exact patch versions in lockfiles/build scripts after a current `/research` pass. Upgrades happen deliberately with contract, migration and packaging tests.

## Native shell

| Need | Choice |
|---|---|
| UI | SwiftUI |
| macOS-specific integration | AppKit and Foundation |
| Concurrency | Swift structured concurrency |
| API types | Swift OpenAPI Generator + URLSession transport |
| Secrets | Security framework / Keychain Services |
| Repository selection | `NSOpenPanel` and durable local grant abstraction |
| Tests | XCTest and XCUITest |

No third-party state-management framework is required for the MVP. Feature-scoped observable models and generated API types are sufficient.

## TypeScript Engine

| Need | Baseline |
|---|---|
| Runtime | Bundled Node.js 24 LTS |
| Package manager | pnpm workspace with committed lockfile |
| Language | TypeScript strict, ESM |
| HTTP | Fastify 5, loopback only |
| Contract validation | Ajv 8 configured for JSON Schema 2020-12 |
| OpenAPI types | `openapi-typescript` or equivalent generated types; YAML remains source of truth |
| Persistence queries | Kysely |
| SQLite driver | `better-sqlite3`, pinned and packaged as a signed native addon |
| Logging | Pino-compatible structured logs with a Jarvis redaction layer |
| Processes | Node `child_process.spawn` behind a Process Port; Execa is acceptable if it improves process-group handling |
| MCP | Official `@modelcontextprotocol/client` v2 line |
| Tests | Vitest for TS; real temp SQLite/Git in integration tests |
| Architecture rules | dependency-cruiser or an equivalent CI import graph check |
| Bundling | esbuild/tsup-style deterministic bundle while keeping native addon external |

## Why Kysely plus better-sqlite3

Kysely provides typed SQL without hiding transactions or migrations. Its SQLite dialect works with `better-sqlite3`. The native addon is a packaging constraint, so the persistence layer must accept an explicit addon path inside the app bundle and the release pipeline must sign it.

The Engine event loop must not perform long synchronous query batches. Transactions stay short; agent processes and network calls remain outside database transactions.

## Contract toolchain

```text
JSON Schema files
  ├── Ajv runtime validation in Engine
  ├── CI validation of examples
  └── manifest/payload registry

OpenAPI YAML
  ├── generated Swift client
  ├── generated TypeScript types
  └── API compatibility tests
```

Do not create a second hand-written DTO source of truth.

## Git

Use the system Git executable through a safe adapter and absolute path detection. Do not use a Git library as the domain boundary. Commands are constructed from typed inputs, use argument arrays and run in the leased worktree.

## Build outputs

```text
dist/engine/engine.bundle.mjs
dist/engine/node
dist/engine/native/better_sqlite3.node
dist/engine/modules/*
dist/engine/contracts/*
dist/engine/migrations/*
```

The Swift build phase copies these into `Jarvis.app/Contents/Resources/engine/` before nested signing.

## Explicitly rejected for the MVP

- Electron or a webview shell.
- Docker/Compose as a runtime dependency.
- A remote broker or database.
- Node's still-evolving built-in SQLite API as the contractual persistence dependency.
- Dynamic npm installation of production modules.
- A framework that centralizes the business workflow.
