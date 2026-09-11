import { cpSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startEngine } from "./harness.js";
import { runEngineToExit } from "./run-engine.js";

const enginePath = fileURLToPath(
  new URL("../../../dist/engine/engine.bundle.mjs", import.meta.url),
);

describe("engine bootstrap failures", () => {
  it("exits non-zero with an actionable message when no session token is supplied", async () => {
    const run = await runEngineToExit({});

    expect(run.code).not.toBe(0);
    // The shell shows this verbatim, so it must name the cause and the next action.
    expect(run.stderr).toContain("JARVIS_API_TOKEN");
    expect(run.stderr).toContain("Jarvis.app");
    // A failed bootstrap must never look like a successful handshake.
    expect(run.stdout).toBe("");
  });

  it("boots degraded, still announcing readiness, when the data root cannot be opened", async () => {
    // Ticket 02: a database that cannot be opened degrades the engine instead
    // of killing it, so the shell stays up and can explain what is wrong
    // (MVP_SPEC.md user story 3) — an exited process would never get to.
    const engine = await startEngine({
      env: { JARVIS_DATA_ROOT: join(enginePath, "not-a-directory") },
    });
    try {
      expect(engine.handshake).toMatchObject({ type: "ready" });

      const health = (await (await engine.call("/v1/health")).json()) as Record<string, unknown>;
      expect(health).toMatchObject({ status: "degraded", database: "failed" });

      // A raw ENOTDIR is exactly what the pre-mkdir lstat exists to avoid.
      await engine.waitForStderr("is a file, not a directory");
      expect(engine.stderr()).not.toContain("ENOTDIR");
    } finally {
      await engine.dispose();
    }
  });

  it("names the bundle-relative SQLite addon when it is missing", async () => {
    const backupRoot = mkdtempSync(join(tmpdir(), "jarvis-addon-"));
    cpSync(dirname(enginePath), backupRoot, { recursive: true });
    const isolatedEnginePath = join(backupRoot, "engine.bundle.mjs");
    const addonPath = join(backupRoot, "native", "better_sqlite3.node");
    const expectedAddonPath = join(realpathSync(backupRoot), "native", "better_sqlite3.node");
    const backupPath = join(backupRoot, "better_sqlite3.node");
    renameSync(addonPath, backupPath);

    try {
      const engine = await startEngine({ enginePath: isolatedEnginePath });
      try {
        await engine.waitForStderr("The SQLite native addon is missing.");
        expect(engine.stderr()).toContain(`Expected it at ${expectedAddonPath}.`);

        const health = (await (await engine.call("/v1/health")).json()) as Record<string, unknown>;
        expect(health).toMatchObject({ status: "degraded", database: "failed" });
      } finally {
        await engine.dispose();
      }
    } finally {
      renameSync(backupPath, addonPath);
      rmSync(backupRoot, { recursive: true, force: true });
    }
  });
});
