# Test Fixtures

## Reference repository

Create a small repository fixture owned by the test suite. It should be fast, deterministic and capable of accepting the canonical ticket:

> Add `GET /health` returning `{ "status": "ok" }` and an automated test.

Suggested shape:

```text
fixtures/reference-repo-template/
├── package.json
├── src/server.ts
├── test/server.test.ts
└── .jarvis/project.yaml
```

Tests copy the template, initialize Git, create an initial commit and generate a local bare remote. Do not commit a nested `.git` directory.

## Fake Agent Runtime executable

A fixture CLI accepts a JSON request over stdin or a request-file argument and emits normalized JSON lines. Scenarios:

- success: writes the health endpoint/test ;
- no-op ;
- validation failure then repair ;
- timeout ;
- cancellation ;
- oversized output ;
- attempted forbidden path.

It is a process, not an in-memory mock, for supervisor and streaming tests.

## Fake GitHub adapter

Use an in-process transport behind the GitHub port for most tests. It stores Issues, label timeline and Pull Requests and supports failpoints:

- timeout before side effect ;
- timeout after side effect ;
- unauthorized ;
- branch missing ;
- duplicate idempotency key ;
- polling overlap/restart.

The adapter exposes the same domain response as the real transport.

## Clocks and IDs

Application Harness injects a controllable clock and deterministic ID generator. Production adapters use wall clock and cryptographic/random IDs. Tests should not assert opaque production ID formats beyond schema constraints.

## Filesystem safety

All fixture roots live under the test temp directory. Tests assert no file was written outside it and clean up even after failure. A separate leak-reconciliation test intentionally leaves a worktree and restarts the Engine.

## Sandbox GitHub repository

Maintain a dedicated private repository for opt-in acceptance. The test creates/labels a disposable Issue and removes or closes generated resources. Never target a real project repository.
