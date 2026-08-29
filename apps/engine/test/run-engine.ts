import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const enginePath = join(repoRoot, "dist", "engine", "engine.bundle.mjs");

const DEFAULT_TIMEOUT_MS = 15_000;

export interface EngineRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunEngineOptions {
  readonly timeoutMs?: number;
}

/**
 * Starts the built engine and resolves once it exits on its own. For the cases
 * that assert the engine *refuses* to start: a regression there would otherwise
 * leave a listening engine behind and hang until vitest's own timeout.
 */
export function runEngineToExit(
  env: Record<string, string | undefined>,
  options: RunEngineOptions = {},
): Promise<EngineRun> {
  // Never inherit the developer's real Application Support directory, which
  // LOCAL_DEVELOPMENT.md forbids tests from touching.
  const supplied = env["JARVIS_DATA_ROOT"];
  const suppliedRoot = supplied === undefined || supplied === "" ? undefined : supplied;
  const dataRoot = suppliedRoot ?? mkdtempSync(join(tmpdir(), "jarvis-run-"));

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [enginePath], {
      cwd: repoRoot,
      env: { ...process.env, JARVIS_API_TOKEN: undefined, ...env, JARVIS_DATA_ROOT: dataRoot },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => void (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => void (stderr += chunk.toString("utf8")));

    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `engine was still running after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms; it was expected to exit.\n${stderr}`,
        ),
      );
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const cleanUp = (): void => {
      clearTimeout(deadline);
      if (suppliedRoot === undefined) rmSync(dataRoot, { recursive: true, force: true });
    };

    child.on("error", (error) => {
      cleanUp();
      reject(error);
    });
    child.on("exit", (code: number | null) => {
      cleanUp();
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
