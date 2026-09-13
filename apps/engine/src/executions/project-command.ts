import { homedir } from "node:os";
import type {
  ModuleShellCommandInput,
  ModuleShellCommandResult,
} from "../../../../packages/module-sdk/src/index.js";
import { runBoundedProcess } from "../../../../packages/workspace/src/bounded-process-runner.js";

/** Fixed tool environment shared by prerequisite probes, preparation and validation. */
export function projectCommandEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env["PATH"] ?? "", HOME: homedir(), LANG: "C", LC_ALL: "C" };
}

export function runProjectCommand(
  input: ModuleShellCommandInput,
): Promise<ModuleShellCommandResult> {
  const windows = process.platform === "win32";
  return runBoundedProcess({
    executable: windows ? "cmd.exe" : "/bin/sh",
    args: windows ? ["/d", "/s", "/c", input.command] : ["-c", input.command],
    cwd: input.cwd,
    env: projectCommandEnvironment(),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.outputLimitBytes === undefined ? {} : { outputLimitBytes: input.outputLimitBytes }),
  });
}
