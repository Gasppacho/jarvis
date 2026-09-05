# MISSION-0019 — Retro

## What slowed this mission down

1. **The `test:swift` breakage from a `required` wire field was not anticipated until
   the first full `pnpm verify`.** Adding `compositionFingerprint` as required in the
   OpenAPI/JSON Schema was correct-looking in isolation and passed `pnpm
   typecheck`/`pnpm contracts:check`/the TypeScript test suites — those never touch
   Swift decoding. The break only surfaced ~15 minutes later, at the most expensive gate
   in the pipeline (a full engine+app+Swift build). Nothing in the mission material or
   `docs/contracts/LOCAL_API_V1.md` flags "adding a required property to a schema that
   already has hand-written Swift test fixtures" as a risk, and the codebase's own
   precedent for this exact situation (`requestAttempts?`/`factDeliveries?` on
   `ProjectValidationReport`, with a comment explaining why they're optional) sits one
   scroll away from where the new field was added, easy to not connect to a *wire*
   `required` decision made in a different file (the OpenAPI YAML).
2. **A tooling mistake wasted one full `pnpm verify` cycle (~2 minutes) and nearly caused
   a false "still running" belief.** Running `nohup pnpm verify > log 2>&1 &` *inside* a
   `run_in_background: true` Bash call double-backgrounds the work: the tool call itself
   returns almost immediately (nohup's `&` returns to the parent shell right away), so
   the harness's completion notification fires for the *launcher*, not for `pnpm verify`
   — and the real process is then an orphan the sandbox may kill once the tracked command
   exits. The log was left truncated mid-`swift build` with no process still running.
   The fix was mechanical (pass `pnpm verify` itself as the backgrounded command, no
   extra `&`/`nohup`), but diagnosing "why does the log stop mid-sentence with nothing
   running" cost a full round trip.
3. **`pnpm lint` is intercepted by the environment's `rtk` command-rewriting hook and
   mis-routed toward a nonexistent `eslint`**, even though this repo's `lint` script is
   `prettier --check .`. Every `pnpm lint`/`pnpm run lint` invocation failed with
   `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL: Command "eslint" not found` regardless of phrasing.
   Worked around by calling `./node_modules/.bin/prettier --check .` directly, which is
   what `pnpm lint` runs anyway — but this is a global environment quirk unrelated to the
   ticket, and it will bite the next mission on this repo identically.
4. **Choosing what to fingerprint required reading five source files before writing a
   line of fingerprint code** (`composition-validator.ts`, `project-types.ts`,
   `service.ts`, `store.ts`, the OpenAPI validation-report schema) to find precisely
   which fields constitute "the composition and Local Bindings saved right now" versus
   "global resource grants" (deliberately excluded) versus "live accessibility" (a probe,
   not durable state, also excluded). This was necessary reading, not wasted time, but it
   is exactly the kind of cross-cutting question a future mission touching validation
   output would hit again.

## What should change in `.agentic/material/`

- **Add a one-line rule to the engineering material:** *"Before marking any new property
  of a Local API wire schema `required`, check for existing Swift test fixtures that
  decode that schema (`grep` the schema/component name under `apps/macos/JarvisAppTests`)
  — if any exist and cannot be touched by the mission's scope, the new property must stay
  optional even when the Engine always populates it."* This would have caught the issue
  in the design phase instead of at the most expensive `pnpm verify` stage, on the very
  first schema-widening mission after the Swift test suite grew large enough for this to
  matter.
- **Record the `rtk`/`pnpm lint` mismatch once, centrally**, e.g. in
  `.agentic/material/` as a standing note: *"`pnpm lint`/`pnpm run lint` may be
  intercepted and mis-rewritten in this sandbox; verify with `./node_modules/.bin/prettier
  --check .` directly (the actual script body) when `pnpm lint` reports a missing
  `eslint`."* Every mission that hits this currently has to rediscover and re-diagnose it
  from scratch.
- **Add the `run_in_background` nohup/`&` footgun to the standing process-hygiene
  guidance** already covering `xctest`/`swift-test` reaping: *"Never wrap the command
  passed to `run_in_background: true` in `nohup ... &`; pass the real long-running
  command directly, or the tool's completion notification fires for the launcher instead
  of the work and the sandbox may kill the detached process mid-run."*
- **No change needed to the mission-contract/execution-plan structure itself** — the
  design-question framing, allowed-scope list and stop conditions in `MISSION-0019`
  correctly anticipated the hard parts (staleness detection, immutability, idempotency,
  no-`apps/macos` boundary) and were sufficient once the Swift/schema interaction above
  was understood.
