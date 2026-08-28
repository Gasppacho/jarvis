import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const enginePath = join(repoRoot, "dist", "engine", "engine.bundle.mjs");

export interface EngineRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Starts the built engine and resolves once it exits on its own. */
export function runEngineToExit(env: Record<string, string | undefined>): Promise<EngineRun> {
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
    child.on("exit", (code: number | null) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
