import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  ChildProcessAgentRun,
  type AgentRunObservation,
  type AgentRunTranslator,
} from "./child-process-agent-run.js";
import type { AgentRun, AgentRunRequest, AgentRuntime, RuntimeDescriptor } from "./index.js";

const CODEX_ID = "runtime/codex-default";
const CODEX_DISPLAY_NAME = "Codex — default";
const CODEX_CAPABILITIES = ["agent.execute"] as const;
const VERSION_ARGS = ["--version"] as const;
const LOGIN_STATUS_ARGS = ["login-status"] as const;
const DEFAULT_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 4_096;
const MAX_OUTPUT_LIMIT_BYTES = 64 * 1024;
const FORCE_KILL_DELAY_MS = 100;
const CODEX_EXEC_ARGS = [
  "exec",
  "--json",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--skip-git-repo-check",
] as const;
const LOGGED_IN_OUTPUT = /^\s*Logged in using ChatGPT\s*$/m;
const NOT_LOGGED_IN_OUTPUT = /^\s*Not logged in\s*$/m;
const CODEX_VERSION_OUTPUT = /^\s*codex-cli\s+(\d+\.\d+\.\d+)\s*$/m;
const CODEX_PROBE_ENVIRONMENT = {
  PATH: process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin:/usr/sbin:/sbin",
  CODEX_HOME: join(homedir(), ".codex"),
};

export interface CodexRuntimeOptions {
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
}

/** Codex-specific discovery and invocation; process mechanics stay shared. */
export class CodexRuntime implements AgentRuntime {
  private readonly executablePath: string | null;
  private readonly timeoutMs: number;
  private readonly outputLimitBytes: number;

  public constructor(executablePath: string | null, options: CodexRuntimeOptions = {}) {
    this.executablePath = executablePath;
    this.timeoutMs = bounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.outputLimitBytes = bounded(
      options.outputLimitBytes,
      DEFAULT_OUTPUT_LIMIT_BYTES,
      MAX_OUTPUT_LIMIT_BYTES,
    );
  }

  public async describe(): Promise<RuntimeDescriptor> {
    const executablePath = this.validDescriptorPath();
    if (executablePath === null) return descriptor(null, null, "unavailable");
    if (!(await isExecutableFile(executablePath))) {
      return descriptor(executablePath, null, "unavailable");
    }

    const versionProbe = await probe(
      executablePath,
      VERSION_ARGS,
      this.timeoutMs,
      this.outputLimitBytes,
    );
    if (versionProbe.timedOut || versionProbe.error) {
      return descriptor(executablePath, null, "unavailable");
    }

    const version = versionProbe.outputLimited ? null : parseVersion(versionProbe.output);
    if (version === null) {
      return descriptor(
        executablePath,
        null,
        versionProbe.output.trim() === "" && versionProbe.exitCode !== 0
          ? "unavailable"
          : "degraded",
      );
    }
    if (versionProbe.exitCode !== 0) return descriptor(executablePath, null, "unavailable");

    const authProbe = await probe(
      executablePath,
      LOGIN_STATUS_ARGS,
      this.timeoutMs,
      this.outputLimitBytes,
    );
    if (authProbe.timedOut || authProbe.error || authProbe.outputLimited) {
      return descriptor(executablePath, version, "unavailable");
    }
    if (authProbe.exitCode === 0 && LOGGED_IN_OUTPUT.test(authProbe.output)) {
      return descriptor(executablePath, version, "available");
    }
    if (NOT_LOGGED_IN_OUTPUT.test(authProbe.output)) {
      return descriptor(executablePath, version, "unauthenticated");
    }
    return descriptor(executablePath, version, "unavailable");
  }

  public async start(request: AgentRunRequest, signal: AbortSignal): Promise<AgentRun> {
    const executablePath = this.validDescriptorPath();
    if (executablePath === null || !(await isExecutableFile(executablePath))) {
      throw new Error("The Codex Runtime executable is unavailable.");
    }

    return new ChildProcessAgentRun({
      request,
      signal,
      executable: executablePath,
      args: [...CODEX_EXEC_ARGS, "--cd", request.workingDirectory, "-"],
      stdin: buildPrompt(request),
      translator: new CodexRunTranslator(),
      displayName: CODEX_DISPLAY_NAME,
    });
  }

  private validDescriptorPath(): string | null {
    return this.executablePath !== null && isAbsolute(this.executablePath)
      ? this.executablePath
      : null;
  }
}

class CodexRunTranslator implements AgentRunTranslator {
  private threadStarted = false;
  private terminal = false;
  private lastAgentMessage: string | undefined;

  public translate(line: string): readonly AgentRunObservation[] {
    if (this.terminal) return [];

    const record = parseRecord(line);
    if (record === null || typeof record["type"] !== "string") return [];

    switch (record["type"]) {
      case "thread.started":
        this.threadStarted = true;
        return [];
      case "item.completed": {
        if (!this.threadStarted) return [];
        const item = record["item"];
        if (!isRecord(item) || item["type"] !== "agent_message") return [];
        const text = item["text"];
        if (typeof text !== "string") return [];
        this.lastAgentMessage = text;
        return [{ type: "message", message: text }];
      }
      case "turn.completed":
        if (!this.threadStarted || this.lastAgentMessage === undefined) return [];
        this.terminal = true;
        return [
          {
            type: "result",
            result: {
              status: "completed",
              summary: this.lastAgentMessage,
              changedFiles: [],
            },
          },
        ];
      default:
        return [];
    }
  }
}

function parseRecord(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ProbeResult {
  readonly output: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outputLimited: boolean;
  readonly error: boolean;
}

function descriptor(
  executablePath: string | null,
  version: string | null,
  status: RuntimeDescriptor["status"],
): RuntimeDescriptor {
  return {
    id: CODEX_ID,
    provider: "codex",
    displayName: CODEX_DISPLAY_NAME,
    executablePath,
    version,
    capabilities: [...CODEX_CAPABILITIES],
    status,
  };
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const file = await stat(path);
    if (!file.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseVersion(output: string): string | null {
  return CODEX_VERSION_OUTPUT.exec(output)?.[1] ?? null;
}

function buildPrompt(request: AgentRunRequest): string {
  return [
    ...request.systemInstructions,
    `Objective:\n${request.objective}`,
    ...request.contextArtifacts.map((artifact) => `Context artifact:\n${artifact}`),
  ].join("\n\n");
}

function probe(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  outputLimitBytes: number,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        env: { ...CODEX_PROBE_ENVIRONMENT },
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve(failedProbe());
      return;
    }

    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let processError = false;
    let termination: "timeout" | "output-limit" | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
    timeoutTimer.unref();

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      resolve({
        output: Buffer.concat(chunks).toString("utf8"),
        exitCode,
        timedOut: termination === "timeout",
        outputLimited: termination === "output-limit",
        error: processError,
      });
    };

    const terminate = (reason: "timeout" | "output-limit"): void => {
      if (settled || termination !== undefined) return;
      termination = reason;
      signalChild(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!settled) signalChild(child, "SIGKILL");
      }, FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
    };

    const consume = (chunk: Buffer | string): void => {
      if (settled || termination !== undefined) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, outputLimitBytes - outputBytes);
      if (remaining > 0) {
        chunks.push(bytes.subarray(0, remaining));
        outputBytes += Math.min(bytes.byteLength, remaining);
      }
      if (bytes.byteLength > remaining) terminate("output-limit");
    };

    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.once("error", () => {
      processError = true;
    });
    child.once("close", (exitCode) => finish(exitCode));
  });
}

function failedProbe(): ProbeResult {
  return { output: "", exitCode: null, timedOut: false, outputLimited: false, error: true };
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The probe may have exited between the two signals.
    }
  }
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}
