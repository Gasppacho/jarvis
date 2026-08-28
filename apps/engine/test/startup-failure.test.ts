import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const enginePath = join(repoRoot, "dist", "engine", "engine.bundle.mjs");

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runEngine(env: Record<string, string | undefined>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [enginePath], {
      cwd: repoRoot,
      env: { ...process.env, JARVIS_API_TOKEN: undefined, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => void (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => void (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe("engine bootstrap failures", () => {
  it("exits non-zero with an actionable message when no session token is supplied", async () => {
    const run = await runEngine({});

    expect(run.code).not.toBe(0);
    // The shell shows this verbatim, so it must name the cause and the next action.
    expect(run.stderr).toContain("JARVIS_API_TOKEN");
    expect(run.stderr).toContain("Jarvis.app");
    // A failed bootstrap must never look like a successful handshake.
    expect(run.stdout).toBe("");
  });

  it("never announces readiness when the data root cannot be opened", async () => {
    const run = await runEngine({
      JARVIS_API_TOKEN: "session-token",
      // A file, not a directory: creating the data root underneath must fail.
      JARVIS_DATA_ROOT: join(enginePath, "not-a-directory"),
    });

    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("failed to start");
  });
});
