import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ChildProcessAgentRun,
  type AgentRunObservation,
  type AgentRunTranslator,
  type ChildProcessFailure,
} from "./child-process-agent-run.js";
import type {
  AgentRun,
  AgentRunRequest,
  AgentRunResult,
  AgentRuntime,
  RuntimeDescriptor,
} from "./types.js";

const CODEX_ID = "runtime/codex-default";
const CODEX_DISPLAY_NAME = "Codex — default";
const CODEX_CAPABILITIES = ["agent.execute"] as const;
const VERSION_ARGS = ["--version"] as const;
const LOGIN_STATUS_ARGS = ["login", "status"] as const;
const DEFAULT_TIMEOUT_MS = 2_000;
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
  "--sandbox",
  "workspace-write",
  "--skip-git-repo-check",
] as const;
const LOGGED_IN_OUTPUT = /^\s*Logged in using ChatGPT\s*$/m;
const NOT_LOGGED_IN_OUTPUT = /^\s*Not logged in\s*$/m;
const CODEX_VERSION_OUTPUT = /^\s*codex-cli\s+(\d+\.\d+\.\d+)\s*$/m;
const AUTHENTICATION_REFUSAL =
  /(?:not\s+logged\s+in|not\s+authenticated|unauthenticated|authentication\s+required|login\s+required|sign(?:[-\s])?in\s+required|please\s+(?:log\s+in|sign\s+in|login))/i;
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

  public async describe(
    environment: Readonly<Record<string, string>> = {},
  ): Promise<RuntimeDescriptor> {
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
      environment,
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
      environment,
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
    if (executablePath === null) {
      throw new Error("The Codex Runtime executable is unavailable.");
    }

    return new ChildProcessAgentRun({
      request,
      signal,
      executable: executablePath,
      args: [...CODEX_EXEC_ARGS, "--cd", request.workingDirectory, "-"],
      stdin: buildPrompt(request),
      translator: new CodexRunTranslator(request.workingDirectory),
      displayName: CODEX_DISPLAY_NAME,
      classifyFailure: classifyCodexFailure,
    });
  }

  private validDescriptorPath(): string | null {
    return this.executablePath !== null && isAbsolute(this.executablePath)
      ? this.executablePath
      : null;
  }
}

class CodexRunTranslator implements AgentRunTranslator {
  private terminal = false;
  private lastAgentMessage: string | undefined;
  private readonly startedCommands = new Map<string, string>();
  private readonly completedCommandIds = new Set<string>();
  private readonly observedChangedFiles: string[] = [];
  private readonly completedFileChangeIds = new Set<string>();

  public constructor(private readonly workingDirectory: string) {}

  public translate(line: string): readonly AgentRunObservation[] {
    if (this.terminal) return [];

    if (line.trim() === "") return [];

    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return this.failure(
        isAuthenticationRefusal(line) ? "agent.codex.unauthenticated" : "agent.codex.invalid-json",
        isAuthenticationRefusal(line)
          ? "Codex is not authenticated. Sign in and retry."
          : "Codex emitted stdout that is not valid JSON.",
        false,
      );
    }

    if (!isRecord(value) || typeof value["type"] !== "string") {
      return [{ type: "warning", message: "Codex emitted an unrecognized JSON event." }];
    }

    const record = value;

    switch (record["type"]) {
      case "thread.started":
      case "turn.started":
        return [];
      case "item.started": {
        const item = record["item"];
        return isRecord(item) && item["type"] === "command_execution"
          ? this.translateCommandStarted(item)
          : [];
      }
      case "item.completed": {
        const item = record["item"];
        if (!isRecord(item)) return [];
        if (item["type"] === "command_execution") return this.translateCommandCompleted(item);
        if (item["type"] === "file_change") return this.translateFileChange(item);
        if (item["type"] !== "agent_message") return [];
        const text = item["text"];
        if (typeof text !== "string") return [];
        this.lastAgentMessage = text;
        return [{ type: "message", message: text }];
      }
      case "turn.completed":
        return this.translateTurnCompleted(record);
      case "turn.failed":
        return this.translateTurnFailed(record);
      case "error":
        return isAuthenticationRefusal(record)
          ? this.failure(
              "agent.codex.unauthenticated",
              "Codex is not authenticated. Sign in and retry.",
              false,
            )
          : [{ type: "warning", message: "Codex emitted an unrecognized JSON event." }];
      default:
        return [{ type: "warning", message: "Codex emitted an unrecognized JSON event." }];
    }
  }

  private translateCommandStarted(item: Record<string, unknown>): readonly AgentRunObservation[] {
    const id = typeof item["id"] === "string" ? item["id"] : undefined;
    const command = item["command"];
    if (
      id === undefined ||
      typeof command !== "string" ||
      command === "" ||
      this.startedCommands.has(id)
    ) {
      return [];
    }

    this.startedCommands.set(id, command);
    return [{ type: "tool-started", message: command }];
  }

  private translateCommandCompleted(item: Record<string, unknown>): readonly AgentRunObservation[] {
    const id = typeof item["id"] === "string" ? item["id"] : undefined;
    const command = id === undefined ? undefined : this.startedCommands.get(id);
    if (id === undefined || command === undefined || this.completedCommandIds.has(id)) return [];

    this.completedCommandIds.add(id);
    const exitCode = readExitCode(item["exit_code"]);
    const output =
      typeof item["aggregated_output"] === "string" ? item["aggregated_output"] : undefined;
    return [
      {
        type: "tool-completed",
        message: `${command} (exit code: ${String(exitCode)})`,
        ...(output === undefined ? {} : { chunk: output }),
      },
    ];
  }

  private translateTurnCompleted(record: Record<string, unknown>): readonly AgentRunObservation[] {
    if (this.lastAgentMessage === undefined) return [];

    const usage = readUsage(record["usage"]);
    this.terminal = true;
    return [
      ...(usage === undefined ? [] : [{ type: "usage" as const, message: formatUsage(usage) }]),
      {
        type: "result",
        result: {
          status: "completed",
          summary: this.lastAgentMessage,
          changedFiles: [...this.observedChangedFiles],
          ...(usage === undefined ? {} : { usage }),
        },
      },
    ];
  }

  private translateTurnFailed(record: Record<string, unknown>): readonly AgentRunObservation[] {
    const unauthenticated = isAuthenticationRefusal(record);
    return this.failure(
      unauthenticated ? "agent.codex.unauthenticated" : "agent.codex.turn-failed",
      unauthenticated
        ? "Codex is not authenticated. Sign in and retry."
        : "Codex reported that the turn failed.",
      unauthenticated ? false : true,
    );
  }

  private translateFileChange(item: Record<string, unknown>): readonly AgentRunObservation[] {
    const id = typeof item["id"] === "string" ? item["id"] : undefined;
    if (id !== undefined && this.completedFileChangeIds.has(id)) return [];

    const changes = item["changes"];
    if (!Array.isArray(changes)) return this.invalidProtocol();

    const paths: string[] = [];
    for (const change of changes) {
      if (!isRecord(change)) return this.invalidProtocol();
      const path = workspaceRelativePath(change["path"], this.workingDirectory);
      if (path === null) return this.invalidProtocol();
      paths.push(path);
    }

    if (id !== undefined) this.completedFileChangeIds.add(id);
    this.observedChangedFiles.push(...paths);
    return paths.map((path) => ({ type: "file-changed", path }));
  }

  private invalidProtocol(): readonly AgentRunObservation[] {
    this.terminal = true;
    return [
      {
        type: "result",
        result: {
          status: "failed",
          summary: "Codex Runtime failed.",
          changedFiles: [...this.observedChangedFiles],
          error: {
            code: "agent.protocol-invalid",
            message: "Codex Runtime reported a changed file outside its working directory.",
            retryable: false,
          },
        },
      },
    ];
  }

  private failure(
    code: string,
    message: string,
    retryable: boolean,
  ): readonly AgentRunObservation[] {
    this.terminal = true;
    return [
      {
        type: "result",
        result: {
          status: "failed",
          summary: "Codex Runtime failed.",
          changedFiles: [...this.observedChangedFiles],
          error: { code, message, retryable },
        },
      },
    ];
  }
}

function workspaceRelativePath(value: unknown, workingDirectory: string): string | null {
  if (typeof value !== "string" || value === "") return null;
  const workspace = resolve(workingDirectory);
  const relativePath = relative(workspace, resolve(workspace, value));
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return relativePath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthenticationRefusal(value: unknown): boolean {
  if (typeof value === "string") return AUTHENTICATION_REFUSAL.test(value);
  if (!isRecord(value)) return false;
  return [value["message"], value["reason"], value["error"]].some(isAuthenticationRefusal);
}

function readExitCode(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function readUsage(value: unknown): AgentRunResult["usage"] | undefined {
  if (!isRecord(value)) return undefined;

  const inputTokens = readTokenCount(value["input_tokens"]);
  const outputTokens = readTokenCount(value["output_tokens"]);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;

  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

function readTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function formatUsage(usage: NonNullable<AgentRunResult["usage"]>): string {
  return [
    usage.inputTokens === undefined ? undefined : `inputTokens=${String(usage.inputTokens)}`,
    usage.outputTokens === undefined ? undefined : `outputTokens=${String(usage.outputTokens)}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
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

function classifyCodexFailure(failure: ChildProcessFailure): AgentRunResult {
  switch (failure.kind) {
    case "spawn":
      return codexFailure(
        "agent.codex.spawn-failed",
        "Codex could not be started. Refresh runtime discovery and retry.",
        false,
      );
    case "process":
      return codexFailure(
        "agent.codex.process-failed",
        "Codex process exited unsuccessfully.",
        true,
      );
    case "missing-result":
      return codexFailure(
        "agent.codex.missing-result",
        "Codex ended without reporting a terminal result.",
        false,
      );
  }
}

function codexFailure(code: string, message: string, retryable: boolean): AgentRunResult {
  return {
    status: "failed",
    summary: "Codex Runtime failed.",
    changedFiles: [],
    error: { code, message, retryable },
  };
}

function probe(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  outputLimitBytes: number,
  environment: Readonly<Record<string, string>>,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        env: environment,
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
