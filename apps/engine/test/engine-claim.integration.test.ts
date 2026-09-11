import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENGINE_CLAIM_FILENAME } from "../src/engine-claim.js";
import { startEngine, type Harness } from "./harness.js";
import { runEngineToExit } from "./run-engine.js";

const ALREADY_RUNNING_CODE = "system.engine-already-running";

describe("Engine data-root claim", () => {
  const started: Harness[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(started.splice(0).map((engine) => engine.dispose()));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function dataRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "jarvis-engine-claim-"));
    roots.push(root);
    return root;
  }

  it("rejects a second process on the same root while the first keeps serving", async () => {
    const root = dataRoot();
    const first = await startEngine({ dataRoot: root });
    started.push(first);

    const second = await runEngineToExit({
      JARVIS_API_TOKEN: "second-session-token",
      JARVIS_DATA_ROOT: root,
    });

    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain(ALREADY_RUNNING_CODE);
    expect(second.stdout).toBe("");

    const health = (await (await first.call("/v1/health")).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ status: "ready", database: "ready" });
  });

  it("takes over a claim whose owner process is gone", async () => {
    const root = dataRoot();
    const owner = spawn(process.execPath, ["-e", ""]);
    const ownerPid = owner.pid;
    if (ownerPid === undefined) throw new Error("test owner process did not expose a PID");
    await new Promise<void>((resolve, reject) => {
      owner.once("error", reject);
      owner.once("exit", () => resolve());
    });
    writeFileSync(
      join(root, ENGINE_CLAIM_FILENAME),
      `${JSON.stringify({ version: 1, pid: ownerPid, sessionId: "stale-session", claimId: "stale-claim" })}\n`,
      { mode: 0o600 },
    );

    const engine = await startEngine({ dataRoot: root });
    started.push(engine);

    expect(engine.handshake.type).toBe("ready");
    expect(JSON.parse(readFileSync(join(root, ENGINE_CLAIM_FILENAME), "utf8"))).toMatchObject({
      pid: expect.any(Number),
      sessionId: expect.not.stringMatching("stale-session"),
    });
  });

  it("releases the claim on graceful shutdown", async () => {
    const root = dataRoot();
    const first = await startEngine({ dataRoot: root });
    started.push(first);

    const shutdown = await first.call("/v1/system/shutdown", { method: "POST" });
    expect(shutdown.status).toBe(202);
    await expect(first.waitForExit()).resolves.toBe(0);
    expect(existsSync(join(root, ENGINE_CLAIM_FILENAME))).toBe(false);

    const second = await startEngine({ dataRoot: root });
    started.push(second);
    expect(second.handshake.type).toBe("ready");
  });

  it("allows engines on different data roots", async () => {
    const first = await startEngine({ dataRoot: dataRoot() });
    const second = await startEngine({ dataRoot: dataRoot() });
    started.push(first, second);

    const health = await Promise.all(
      [first, second].map(
        async (engine) =>
          (await (await engine.call("/v1/health")).json()) as Record<string, unknown>,
      ),
    );
    expect(health).toEqual([
      expect.objectContaining({ status: "ready", database: "ready" }),
      expect.objectContaining({ status: "ready", database: "ready" }),
    ]);
  });
});
