import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
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

  it("creates a data root that does not exist yet under a root-owned parent", async () => {
    // The flow LOCAL_DEVELOPMENT.md prescribes: JARVIS_DATA_ROOT=/tmp/jarvis-dev-<id>
    // on a first run. Every other test pre-creates its root with mkdtemp, which
    // takes the other branch and hides this one entirely.
    //
    // Literal /tmp, not os.tmpdir(): on macOS the latter is /var/folders/…/T,
    // which the user owns, so the root-owned-parent case would never be reached.
    const dataRoot = `/tmp/jarvis-first-run-${randomBytes(6).toString("hex")}`;
    created.push(dataRoot);
    expect(existsSync(dataRoot)).toBe(false);

    const engine = await startEngine({ dataRoot });
    try {
      expect(engine.handshake.apiVersion).toBe("v1");
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

describe("database file", () => {
  it("refuses to open the database through a planted symbolic link", async () => {
    // The data root may have been loose when the engine found it, long enough
    // for another account to leave a link named jarvis.sqlite behind.
    const dataRoot = tempDir(0o777);
    const elsewhere = join(tempDir(), "somewhere-else.conf");
    writeFileSync(elsewhere, "");
    symlinkSync(elsewhere, join(dataRoot, "jarvis.sqlite"));

    const run = await runEngineToExit({ JARVIS_DATA_ROOT: dataRoot, JARVIS_API_TOKEN: "t" });

    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("symbolic link");
    // The link target must not have become a database.
    expect(existsSync(`${elsewhere}-wal`)).toBe(false);
  });

  it("closes the database when the engine cannot bind its port", async () => {
    // openDatabase has already run the migrations by then, so bailing without
    // closing would leave the whole schema in an un-checkpointed WAL.
    const dataRoot = tempDir();
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const { port } = occupied.address() as { port: number };

    try {
      const run = await runEngineToExit({
        JARVIS_DATA_ROOT: dataRoot,
        JARVIS_API_TOKEN: "t",
        JARVIS_PORT: String(port),
      });

      expect(run.code).not.toBe(0);
      expect(run.stdout).toBe("");
      expect(existsSync(join(dataRoot, "jarvis.sqlite-wal"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});
