import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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

  it("never announces readiness when the data root cannot be opened", async () => {
    const run = await runEngineToExit({
      JARVIS_API_TOKEN: "session-token",
      // A file, not a directory: creating the data root underneath must fail.
      JARVIS_DATA_ROOT: join(enginePath, "not-a-directory"),
    });

    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe("");
    // A raw ENOTDIR is exactly what the pre-mkdir lstat exists to avoid.
    expect(run.stderr).toContain("is a file, not a directory");
    expect(run.stderr).not.toContain("ENOTDIR");
  });
});
