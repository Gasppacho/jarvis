# MISSION-0015 — Retro

## What slowed this mission down

1. **The handoff's "60% done" work had a fatal YAML syntax error at its
   core.** `contracts/openapi/local-api.v1.yaml` did not parse. This alone
   explains why the previous run never got to `pnpm generate` — it likely
   died mid-edit of exactly that block. A single `node -e
   "yaml.parse(...)"` sanity check would have caught this in seconds; I
   didn't run one until well into reviewing the file by eye. **For next
   time**: on any continuation mission, parse every YAML/JSON contract file
   standalone (not through the full `pnpm generate` pipeline) as the very
   first verification step, before reading the diff for content.

2. **Wrong assumption: "widen the validator" was read as "widen the public
   wire contract."** The mission text said "widen the validator's exposed
   result rather than duplicating it" — correct advice for the *TS domain
   type* `ProjectValidationReport`, consumed in-process by
   `compositionGraph()`. I (and, before me, the previous run) also widened
   the *OpenAPI/JSON-Schema* contract for the pre-existing
   `/validation-report` endpoint to match, which was never necessary — the
   graph builder never crosses an HTTP boundary to get the validator's
   output. This cost a full diagnostic detour: a Swift `SIGSEGV` in
   generated code, crash-log analysis, two wrong hypotheses (oneOf shape,
   then required-vs-optional) before landing on "these fields don't belong
   on the wire schema at all." **For next time**: before widening a
   *public* contract to satisfy an *internal* consumer, ask whether the
   consumer is actually external (crosses a process/wire boundary) or
   in-process. If in-process, widen only the TS type and leave the wire
   schema alone.

3. **`swift-openapi-generator` has a real codegen bug**: a struct with a
   `oneOf`-typed array field crashes its own synthesized `deinit` at
   runtime (SIGSEGV, not a compile error — nothing in `pnpm typecheck`,
   `pnpm build:app`, or even `swift build` catches it). Confirmed via crash
   log (`~/Library/Logs/DiagnosticReports/xctest-*.ips`), not by reading
   generator source. This is invisible until an actual value of that type
   is constructed or destroyed at runtime — `swift build`/`pnpm build:app`
   stays green. **For next time**: when a Local API contract change adds a
   `oneOf`- or `anyOf`-typed field to a struct that Swift code already
   constructs (decode fixtures, hand-written models), run `swift test`
   before declaring the contract change safe — `pnpm typecheck` and
   `swift build` are not sufficient signal. Consider flagging this as a
   known landmine in `.agentic/material/` so future missions touching
   `contracts/openapi/local-api.v1.yaml` don't have to rediscover it.

4. **Ambient tool friction**: the `rtk`-wrapped `grep`/`vitest` output was
   sometimes truncated or reformatted unhelpfully (e.g. `grep -n "a\|b\|c"`
   returning "N matches in N files" with mangled line numbers instead of
   the actual matches). Had to fall back to `awk`/`python3` or route vitest
   through a log file for several lookups. Not a blocker, just repeated
   small overhead.

## What should change in `.agentic/material/` for the next mission

- A short "landmine" note: **do not add `oneOf`/`anyOf`-typed fields to any
  OpenAPI schema that is (a) already used by hand-written Swift code
  (decode call sites, test fixtures) and (b) not purely additive-optional
  without discriminated variants** — verify with a full `swift test` run,
  not just `swift build`, before trusting the change. Point at this
  mission's crash signature (`outlined destroy of Components.Schemas.X`,
  `SIGSEGV` in `_swift_release_dealloc`) as the fingerprint to recognize it
  faster next time.
- A short reminder: **"widen the validator" in a mission brief means the
  TS domain type consumed in-process, not automatically the OpenAPI/JSON
  Schema wire contract** — check whether the new consumer actually crosses
  an HTTP boundary before touching `contracts/`.
- A one-line pre-flight step for any continuation mission inheriting
  uncommitted contract changes: `node -e
  "require('yaml').parse(require('fs').readFileSync(path,'utf8'))"` on
  every touched YAML file, before anything else.
