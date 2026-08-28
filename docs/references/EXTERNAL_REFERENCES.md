# External References

Checked on 2026-08-28. Re-verify current versions and platform rules with `/research` before release work.

## Matt Pocock skills

- [Skills repository and installation](https://github.com/mattpocock/skills)
- [setup-matt-pocock-skills](https://github.com/mattpocock/skills/blob/main/skills/engineering/setup-matt-pocock-skills/SKILL.md)
- [to-spec](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-spec/SKILL.md)
- [to-tickets](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-tickets/SKILL.md)
- [implement](https://github.com/mattpocock/skills/blob/main/skills/engineering/implement/SKILL.md)
- [domain-modeling](https://github.com/mattpocock/skills/blob/main/skills/engineering/domain-modeling/SKILL.md)
- [writing-for-agents](https://github.com/mattpocock/skills/blob/main/skills/productivity/writing-for-agents/SKILL.md)

The pack follows their current conventions: per-repo setup, concise context pointers, glossary `CONTEXT.md` files, terse ADRs, specs with explicit test seams, tracer-bullet tickets and implementation with TDD/review.

## macOS distribution and files

- [Apple — Notarizing macOS software before distribution](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Apple — Accessing files from the macOS App Sandbox](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox)
- [Apple — SwiftUI](https://developer.apple.com/xcode/swiftui/)

## Engine runtime and MCP

- [Node.js release schedule](https://nodejs.org/en/about/previous-releases)
- [Official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

The chosen baseline is Node.js 24 LTS embedded in the app. Pin the exact patch version in build tooling and update it through the release process.

## API contract

- [Apple Swift OpenAPI Generator](https://github.com/apple/swift-openapi-generator)
- [OpenAPI Specification](https://spec.openapis.org/oas/latest.html)
- [JSON Schema 2020-12](https://json-schema.org/draft/2020-12)


## Engine implementation candidates

- [Fastify](https://fastify.dev/)
- [Ajv — JSON Schema 2020-12](https://ajv.js.org/json-schema.html)
- [Kysely](https://kysely.dev/)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)

These libraries are implementation baselines, not domain contracts. Pin exact versions and verify Node/macOS packaging compatibility during Ticket 01.
