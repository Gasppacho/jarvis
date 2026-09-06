/**
 * Ticket #58 (docs/engineering/TEST_FIXTURES.md "Failpoint persistence to
 * simulate crash aux frontières transactionnelles"): a deterministic crash
 * point the Application Harness arms through `JARVIS_FAILPOINT`, an
 * environment variable the macOS shell never sets and no launcher documents
 * (SYSTEM.md's startup protocol passes `JARVIS_DATA_ROOT`/`JARVIS_API_TOKEN`/
 * `JARVIS_SESSION_ID`/`JARVIS_PORT` only).
 *
 * That alone does not make this inert: every call site below used to be
 * compiled unconditionally into the engine that ships inside Jarvis.app, so
 * an unprivileged local process could still arm it there (`launchctl setenv
 * JARVIS_FAILPOINT ...` persists across the app's own launches, and
 * EngineSupervisor only strips a few specific keys from the inherited
 * environment). Post-review-fix, every call site is wrapped in
 * `if (__JARVIS_TEST_HOOKS__) { ... }`, a compile-time flag `tsup.config.ts`
 * sets to `false` for the entry `scripts/build-app.sh` packages and `true`
 * only for the separate entry the Application Harness runs against — so this
 * module is not reachable code in the shipped bundle at all, proven by
 * `apps/engine/test/failpoint-bundle.test.ts` grepping that bundle for this
 * mechanism's identifying strings. The "inert outside tests" case in
 * `apps/engine/test/durability.integration.test.ts` proves the narrower,
 * still-true fact that with `JARVIS_FAILPOINT` unset, the test-hooks build
 * itself never crashes.
 *
 * Read once at module load, not per call: the value cannot change for the
 * life of an engine process, and reading it fresh each time would only add
 * cost to a check every declared transactional boundary makes.
 *
 * Gated behind `__JARVIS_TEST_HOOKS__` too, not just at each call site: a
 * bare `process.env["JARVIS_FAILPOINT"]` read is a side effect esbuild will
 * not tree-shake away on its own, so without this the production entry would
 * still carry this module (and the `JARVIS_FAILPOINT` string) even once
 * every call to `failpoint()` below was itself eliminated.
 */
declare const __JARVIS_TEST_HOOKS__: boolean | undefined;
const ARMED_FAILPOINT =
  typeof __JARVIS_TEST_HOOKS__ === "undefined" || __JARVIS_TEST_HOOKS__
    ? process.env["JARVIS_FAILPOINT"]
    : undefined;

/**
 * Stops the engine, right now, if `id` is the one armed failpoint for this
 * process. `SIGKILL` to self, never `process.exit`: a graceful exit would run
 * shutdown hooks (WAL checkpoint, `app.close()`) that a real crash never gets
 * to run, which would hide exactly the partial-state bugs this ticket exists
 * to catch. SIGKILL cannot be caught, blocked or ignored, so the calling
 * transaction's COMMIT — the next statement after most call sites — is never
 * reached, and control never returns here.
 */
export function failpoint(id: string): void {
  if (ARMED_FAILPOINT !== id) return;
  process.kill(process.pid, "SIGKILL");
}
