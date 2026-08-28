import { chmodSync, lstatSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine } from "./harness.js";
import { runEngineToExit } from "./run-engine.js";

const created: string[] = [];

function tempDir(mode?: number): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-data-root-"));
  created.push(dir);
  // mkdtemp always yields 0700, so a test about tightening has to loosen first.
  if (mode !== undefined) chmodSync(dir, mode);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("data root", () => {
  it("tightens a data root that already existed with loose permissions", async () => {
    // The case the guard exists for: `mkdirSync` ignores `mode` on an existing
    // path, so a pre-created world-readable root would otherwise stay that way.
    const dataRoot = tempDir(0o777);
    expect(statSync(dataRoot).mode & 0o077).not.toBe(0);

    const engine = await startEngine({ dataRoot });
    try {
      expect(statSync(dataRoot).mode & 0o077).toBe(0);
    } finally {
      await engine.dispose();
    }
  });

  it("refuses a data root that is a symbolic link", async () => {
    // LOCAL_DEVELOPMENT.md documents a predictable path under world-writable
    // /tmp, so another account can plant a link there first.
    const real = tempDir();
    const link = join(tempDir(), "data-root");
    symlinkSync(real, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    const run = await runEngineToExit({ JARVIS_DATA_ROOT: link, JARVIS_API_TOKEN: "t" });

    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("symbolic link");
  });
});
