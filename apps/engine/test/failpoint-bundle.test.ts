import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Review fix for ticket #58: a code review found the crash-recovery
 * failpoint and the `/test/*` durability routes shipped inside
 * `dist/engine/engine.bundle.mjs` — the exact file
 * `scripts/build-app.sh`/`pnpm build:app` copies into `Jarvis.app` — even
 * though nothing in a normal launch ever sets `JARVIS_ENABLE_TEST_HOOKS`.
 * `apps/macos/JarvisCore/EngineSupervisor/EngineSupervisor.swift` inherits
 * the rest of the parent environment, so an unprivileged local process could
 * arm a mid-transaction `SIGKILL` via `launchctl setenv JARVIS_FAILPOINT ...`
 * on every subsequent launch.
 *
 * `apps/engine/tsup.config.ts` now compiles two entries from the same
 * `src/main.ts`: `engine.bundle` (production, `__JARVIS_TEST_HOOKS__` defined
 * `false`) and `engine.test-bundle` (the Application Harness's build,
 * defined `true`). The `if (__JARVIS_TEST_HOOKS__) { ... }` guards at every
 * call site (apps/engine/src/events/dispatcher.ts,
 * apps/engine/src/executions/delivery-consumer.ts,
 * apps/engine/src/http/server.ts, apps/engine/src/main.ts) let esbuild fold
 * the production entry's branch away as dead code, along with the imports
 * and string literals only that branch referenced. This test is the proof:
 * it greps the actual production artifact, not the source.
 */
const productionBundlePath = fileURLToPath(
  new URL("../../../dist/engine/engine.bundle.mjs", import.meta.url),
);

const FORBIDDEN_STRINGS = [
  "JARVIS_FAILPOINT",
  "JARVIS_ENABLE_TEST_HOOKS",
  "/test/events",
  "/test/projects",
  "/test/redeliver",
] as const;

describe("the production engine bundle carries none of the failpoint/test-hooks mechanism", () => {
  it("contains none of the failpoint/test-hooks identifying strings", async () => {
    const bundle = await readFile(productionBundlePath, "utf8");

    const found = FORBIDDEN_STRINGS.filter((needle) => bundle.includes(needle));
    expect(found).toEqual([]);
  });
});
