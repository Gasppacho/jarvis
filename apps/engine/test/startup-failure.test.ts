import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const enginePath = join(repoRoot, "dist", "engine", "engine.bundle.mjs");

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const dataRoots: string[] = [];

/**
 * A throwaway data root for every run. LOCAL_DEVELOPMENT.md forbids touching the
 * developer's real Application Support directory, and relying on `loadConfig`
 * throwing first would make that guarantee an accident of ordering.
 */
function freshDataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-startup-"));
  dataRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of dataRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runEngine(env: Record<string, string | undefined>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [enginePath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        JARVIS_API_TOKEN: undefined,
        JARVIS_DATA_ROOT: freshDataRoot(),
        ...env,
      },
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
