# ADR 0017 — Resolve GitHub credentials through `gh`

## Decision

For the MVP, a GitHub Connection Descriptor's `secretRef` names an account
authenticated in the local `gh` CLI. The provider adapter resolves that
credential at call time with `gh auth token --user`; it never stores, logs,
serializes or checkpoints the returned value.

The adapter locates `gh` by an absolute executable path, uses a bounded process
group, and reports missing executables or failed account authentication as
connection state. It never silently falls back to another account.

Validation performs one read-only `GET /user` call after resolving the account.
On success it persists only the account label and advertised capabilities. A
Project-bound GitHub API client retains the opaque reference and repeats this
resolution for each provider request; the token is never part of a descriptor,
binding, event, prompt, artifact or log.

## Consequences

Users authenticate with `gh` outside Jarvis. A future Keychain-backed adapter
can implement the same port without changing Project Bindings or module
capability names.
