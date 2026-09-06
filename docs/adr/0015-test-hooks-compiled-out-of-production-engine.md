# ADR 0015 — The failpoint/test-hooks seam is compiled out of the production engine

**Status:** Accepted
**Date:** 2026-09-06

Ticket #58 added a crash-recovery failpoint (`JARVIS_FAILPOINT`, `apps/engine/src/test-support/failpoint.ts`) and a test-only HTTP surface (`/test/projects`, `/test/events`, `/test/redeliver`, gated by `JARVIS_ENABLE_TEST_HOOKS`, `apps/engine/src/test-support/durability-test-routes.ts`) so the Application Harness could deterministically crash the engine at a declared transactional boundary and prove Outbox/Delivery/Execution recovery. A review found both compiled unconditionally into the one engine bundle `scripts/build-app.sh` copies into `Jarvis.app`. The MVP ships without App Sandbox (`docs/architecture/SECURITY.md`), and `EngineSupervisor` forwarded the rest of its parent's environment unfiltered, so an unprivileged local process could run `launchctl setenv JARVIS_FAILPOINT after-outbox-commit` — session-persistent, no privilege required — and arm a mid-transaction `SIGKILL` on every subsequent launch of the shipped app.

**Decision.** The mechanism is absent from the production engine by construction, not by "nothing sets the variable." `apps/engine/tsup.config.ts` builds two entries from the same `src/main.ts`, distinguished by a compile-time constant `__JARVIS_TEST_HOOKS__`:

- `engine.bundle` — defined `false`. Every failpoint call and the test-routes registration sit behind `if (__JARVIS_TEST_HOOKS__) { ... }`, so esbuild's dead-code elimination drops the branches, their imports, and the identifying strings (`JARVIS_FAILPOINT`, `JARVIS_ENABLE_TEST_HOOKS`, the three `/test/*` paths) from the compiled output. This is the only entry `scripts/build-app.sh`/`pnpm build:app` copies into `Jarvis.app`.
- `engine.test-bundle` — defined `true`. The Application Harness (`apps/engine/test/harness.ts`) runs this entry instead, so the durability suite still exercises the real mechanism end to end.

`apps/engine/test/failpoint-bundle.test.ts` greps the actual `engine.bundle.mjs` artifact for the five identifying strings on every build and fails if any are found — the guarantee is checked, not assumed.

As defense in depth, `EngineSupervisor.makeProcess` (`apps/macos/JarvisCore/EngineSupervisor/EngineSupervisor.swift`) also strips `JARVIS_FAILPOINT` and `JARVIS_ENABLE_TEST_HOOKS` from the child's inherited environment, alongside the keys it already owned (`JARVIS_PORT`, `JARVIS_SESSION_ID`, `JARVIS_DATA_ROOT`). This is a second, independent layer: the primary guarantee is that the shipped bundle has nothing these variables could turn on; the strip means an ambient value has nowhere to land even if a future change reintroduces the mechanism unconditionally.

## What this rests on

- The production entry's compiled absence of the mechanism, re-verified by `failpoint-bundle.test.ts` on every build — this is the load-bearing guarantee.
- The environment strip in `EngineSupervisor`, which only matters if the first guarantee is ever broken.

Neither guarantee depends on `JARVIS_ENABLE_TEST_HOOKS` being undocumented or on no launcher setting it; both hold against an adversarial local process.

## Rejected

- **A runtime check alone** (`if (process.env.JARVIS_ENABLE_TEST_HOOKS === "1")` with no compile-time flag) — this is what shipped originally, and it does not remove the strings or the reachable code from the signed bundle; it only makes the mechanism harder to trigger, not absent.
- **A separate source tree or package for the test-only code** — two tsup entries from the same `src/main.ts` give the same guarantee with far less duplication, since the Application Harness needs the exact same composition root, only with the flag flipped.
