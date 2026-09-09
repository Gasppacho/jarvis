import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

export interface RuntimeDescriptor {
  readonly id: string;
  readonly provider: "fake" | "codex" | "claude-code" | string;
  readonly displayName: string;
  readonly executablePath: string | null;
  readonly version: string | null;
  readonly capabilities: string[];
  readonly status: "available" | "unavailable" | "unauthenticated" | "degraded";
}

export interface AgentRunRequest {
  readonly projectId: string;
  readonly executionId: string;
  readonly workingDirectory: string;
  readonly objective: string;
  readonly systemInstructions: string[];
  readonly contextArtifacts: string[];
  readonly allowedMcpBindings: string[];
  readonly environment: Record<string, string>;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
}

export type AgentRunEventType =
  | "started"
  | "message"
  | "stdout"
  | "stderr"
  | "tool-started"
  | "tool-completed"
  | "file-changed"
  | "usage"
  | "warning"
  | "completed"
  | "failed";

export interface AgentRunEvent {
  readonly type: AgentRunEventType;
  readonly timestamp: string;
  readonly sequence: number;
  readonly message?: string;
  readonly chunk?: string;
  readonly path?: string;
  readonly result?: AgentRunResult;
}

export interface AgentRunResult {
  readonly status: "completed" | "failed" | "cancelled" | "timed-out";
  readonly summary: string;
  readonly changedFiles: string[];
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly costUsd?: number;
  };
  readonly rawArtifactRef?: string;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export interface AgentRuntime {
  describe(): Promise<RuntimeDescriptor>;
  start(request: AgentRunRequest, signal: AbortSignal): Promise<AgentRun>;
}

export interface AgentRun {
  events(): AsyncIterable<AgentRunEvent>;
  result(): Promise<AgentRunResult>;
  interrupt(): Promise<void>;
}

const FAKE_RUNTIME_DESCRIPTOR: RuntimeDescriptor = {
  id: "runtime/fake-test",
  provider: "fake",
  displayName: "Fake Runtime",
  executablePath: null,
  version: null,
  capabilities: ["agent.execute"],
  status: "available",
};

export class FakeRuntime implements AgentRuntime {
  public async describe(): Promise<RuntimeDescriptor> {
    return {
      ...FAKE_RUNTIME_DESCRIPTOR,
      capabilities: [...FAKE_RUNTIME_DESCRIPTOR.capabilities],
    };
  }

  public async start(request: AgentRunRequest, signal: AbortSignal): Promise<AgentRun> {
    return new FakeAgentRun(request, signal);
  }
}

/** Real child-process adapter for the deterministic test runtime. */
export class FakeAgentRun implements AgentRun {
  public readonly processId: number;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly eventHistory: AgentRunEvent[] = [];
  private readonly eventWaiters = new Set<() => void>();
  private readonly resultPromise: Promise<AgentRunResult>;
  private readonly observedChangedFiles: string[] = [];
  private terminationPromise: Promise<void> | undefined;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private stderrSummary = "";
  private outputBytes = 0;
  private capturedOutputBytes = 0;
  private outputLimitWarned = false;
  private nextSequence = 1;
  private terminal = false;
  private terminationReason: "cancelled" | "timed-out" | undefined;
  private pendingResult: AgentRunResult | undefined;

  public constructor(
    private readonly request: AgentRunRequest,
    signal: AbortSignal,
  ) {
    this.child = spawn(process.execPath, ["-e", FAKE_CHILD_SOURCE], {
      cwd: request.workingDirectory,
      env: { ...request.environment },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (this.child.pid === undefined) {
      throw new Error("The Fake Runtime child process did not expose a pid.");
    }
    this.processId = this.child.pid;
    this.emit({ type: "started" });
    this.resultPromise = this.readResult();
    const repairContext =
      request.systemInstructions.find((instruction) =>
        instruction.includes("Validation failure"),
      ) ?? "";
    this.child.stdin.end(
      JSON.stringify({
        scenario: request.environment["JARVIS_FAKE_SCENARIO"],
        repair: repairContext !== "",
        repairContext,
      }),
    );
    this.timeoutTimer = setTimeout(() => {
      void this.requestTermination("timed-out").catch(() => {});
    }, request.timeoutMs);
    if (signal.aborted) void this.interrupt();
    else signal.addEventListener("abort", () => void this.interrupt(), { once: true });
  }

  private readonly timeoutTimer: NodeJS.Timeout;

  public async *events(): AsyncIterable<AgentRunEvent> {
    let index = 0;
    for (;;) {
      while (index < this.eventHistory.length) {
        const event = this.eventHistory[index];
        index += 1;
        if (event !== undefined) yield event;
      }
      if (this.terminal) return;
      await new Promise<void>((resolveWaiter) => this.eventWaiters.add(resolveWaiter));
    }
  }

  public result(): Promise<AgentRunResult> {
    return this.resultPromise;
  }

  public async interrupt(): Promise<void> {
    await this.requestTermination("cancelled");
    await this.resultPromise;
  }

  private async requestTermination(reason: "cancelled" | "timed-out"): Promise<void> {
    if (this.terminationPromise === undefined && !this.terminal) {
      this.terminationReason = reason;
      this.terminationPromise = this.terminateChild();
    }
    await this.terminationPromise;
  }

  private async terminateChild(): Promise<void> {
    this.signalChild("SIGTERM");
    await Promise.race([this.resultPromise, delay(FORCE_KILL_DELAY_MS)]);
    if (!this.terminal) this.signalChild("SIGKILL");
  }

  private readResult(): Promise<AgentRunResult> {
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");

    return new Promise((resolveResult) => {
      let settled = false;
      const finish = (result: AgentRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(this.timeoutTimer);
        const finalResult =
          this.terminationReason === undefined ? result : terminatedResult(this.terminationReason);
        this.finish(finalResult);
        resolveResult(finalResult);
      };

      this.child.stdout.on("data", (chunk: string) => this.consumeOutput("stdout", chunk));
      this.child.stderr.on("data", (chunk: string) => this.consumeOutput("stderr", chunk));
      this.child.once("error", (error) =>
        finish(failedResult("agent.process-error", error.message, true)),
      );
      this.child.once("close", (exitCode, signal) => {
        this.flushOutput("stdout");
        this.flushOutput("stderr");
        if (exitCode !== 0) {
          finish(
            failedResult(
              "agent.process-failed",
              `Fake Runtime exited with ${signal ?? `code ${String(exitCode)}`}.${this.stderrSummary === "" ? "" : ` ${this.stderrSummary}`}`,
              false,
            ),
          );
          return;
        }

        if (this.pendingResult !== undefined) {
          finish(
            this.pendingResult.status === "completed" &&
              !sameFiles(this.pendingResult.changedFiles, this.observedChangedFiles)
              ? failedResult(
                  "agent.protocol-invalid",
                  "The Fake Runtime result disagrees with its file-changed events.",
                  false,
                )
              : this.pendingResult,
          );
        } else {
          finish(
            failedResult(
              "agent.invalid-result",
              "The Fake Runtime closed without a result line.",
              false,
            ),
          );
        }
      });
    });
  }

  private consumeOutput(kind: "stdout" | "stderr", chunk: string): void {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    this.outputBytes += Buffer.byteLength(text, "utf8");
    if (this.outputBytes > this.request.outputLimitBytes && !this.outputLimitWarned) {
      this.outputLimitWarned = true;
      this.emit({
        type: "warning",
        message: `Fake Runtime output exceeded ${this.request.outputLimitBytes} bytes; raw output was truncated.`,
      });
    }

    if (kind === "stdout") this.stdoutBuffer += text;
    else this.stderrBuffer += text;
    this.consumeLines(kind);
  }

  private consumeLines(kind: "stdout" | "stderr"): void {
    for (;;) {
      const buffer = kind === "stdout" ? this.stdoutBuffer : this.stderrBuffer;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(buffer, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
          this.setBuffer(kind, "");
          this.emit({
            type: "warning",
            message: "Fake Runtime discarded an overlong protocol line.",
          });
        }
        return;
      }

      const line = buffer.slice(0, newline).replace(/\r$/, "");
      this.setBuffer(kind, buffer.slice(newline + 1));
      if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
        this.emit({
          type: "warning",
          message: "Fake Runtime discarded an overlong protocol line.",
        });
      } else {
        this.handleLine(kind, line);
      }
    }
  }

  private flushOutput(kind: "stdout" | "stderr"): void {
    const buffer = kind === "stdout" ? this.stdoutBuffer : this.stderrBuffer;
    if (buffer !== "") {
      this.setBuffer(kind, "");
      this.handleLine(kind, buffer);
    }
  }

  private setBuffer(kind: "stdout" | "stderr", value: string): void {
    if (kind === "stdout") this.stdoutBuffer = value;
    else this.stderrBuffer = value;
  }

  private handleLine(kind: "stdout" | "stderr", line: string): void {
    if (kind === "stderr") {
      this.stderrSummary =
        `${this.stderrSummary}${this.stderrSummary === "" ? "" : " "}${sanitizeOutput(line, this.request)}`.slice(
          0,
          4096,
        );
      this.emitRaw("stderr", line);
      return;
    }

    const trimmed = line.trim();
    if (trimmed === "") return;
    let record: unknown;
    try {
      record = JSON.parse(trimmed) as unknown;
    } catch {
      this.emit({ type: "warning", message: "Fake Runtime emitted malformed JSON output." });
      return;
    }

    if (!isRecord(record) || typeof record["type"] !== "string") {
      this.emitRaw("stdout", line);
      return;
    }

    switch (record["type"]) {
      case "message":
        if (typeof record["message"] !== "string") {
          this.emit({ type: "warning", message: "Fake Runtime emitted an invalid message line." });
        } else {
          const message = this.captureOutput(sanitizeOutput(record["message"], this.request));
          if (message !== "") this.emit({ type: "message", message });
        }
        return;
      case "file-changed": {
        const path = record["path"];
        if (!isSafeRelativePath(path, this.request.workingDirectory)) {
          this.emit({ type: "warning", message: "Fake Runtime reported an invalid changed file." });
        } else {
          this.observedChangedFiles.push(path);
          this.emit({ type: "file-changed", path });
        }
        return;
      }
      case "result":
        try {
          this.pendingResult = readChildResult(record, this.request.workingDirectory);
        } catch (error) {
          this.pendingResult = failedResult(
            "agent.invalid-result",
            error instanceof Error ? error.message : String(error),
            false,
          );
        }
        return;
      case "warning":
        this.emit({
          type: "warning",
          message:
            typeof record["message"] === "string"
              ? sanitizeOutput(record["message"], this.request)
              : "Fake Runtime emitted a warning.",
        });
        return;
      default:
        this.emitRaw("stdout", line);
    }
  }

  private emitRaw(type: "stdout" | "stderr", value: string): void {
    const text = sanitizeOutput(value, this.request);
    const bytes = Buffer.from(text, "utf8");
    const remaining = Math.max(
      0,
      Math.floor(this.request.outputLimitBytes - this.capturedOutputBytes),
    );
    const visible = bytes.subarray(0, remaining).toString("utf8");
    this.capturedOutputBytes += Buffer.byteLength(visible, "utf8");
    if (visible !== "") this.emit({ type, chunk: visible });
  }

  private captureOutput(value: string): string {
    const bytes = Buffer.from(value, "utf8");
    const remaining = Math.max(0, this.request.outputLimitBytes - this.capturedOutputBytes);
    const visible = bytes.subarray(0, remaining).toString("utf8");
    this.capturedOutputBytes += Buffer.byteLength(visible, "utf8");
    return visible;
  }

  private emit(event: Omit<AgentRunEvent, "sequence" | "timestamp">): void {
    this.eventHistory.push({
      ...event,
      sequence: this.nextSequence,
      timestamp: new Date().toISOString(),
    });
    this.nextSequence += 1;
    for (const resolveWaiter of this.eventWaiters) resolveWaiter();
    this.eventWaiters.clear();
  }

  private finish(result: AgentRunResult): void {
    if (this.terminal) return;
    this.terminal = true;
    this.emit({
      type: result.status === "completed" ? "completed" : "failed",
      result,
    });
  }

  private signalChild(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined || this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      if (process.platform === "win32") this.child.kill(signal);
      else process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

const MAX_PROTOCOL_LINE_BYTES = 64 * 1024;
const FORCE_KILL_DELAY_MS = 250;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function readChildResult(value: unknown, workingDirectory: string): AgentRunResult {
  if (isRecord(value) && value["status"] === "completed") {
    return readCompletedResult(value, workingDirectory);
  }
  if (isRecord(value) && value["status"] === "failed") {
    return failedResult(
      "agent.child-failed",
      typeof value["message"] === "string" ? value["message"] : "Fake Runtime reported failure.",
      false,
    );
  }
  throw new Error("The Fake Runtime returned an invalid result line.");
}

function readCompletedResult(value: unknown, workingDirectory: string): AgentRunResult {
  if (!isRecord(value) || value["status"] !== "completed") {
    throw new Error("The Fake Runtime returned an invalid completed result.");
  }
  const summary = value["summary"];
  const changedFiles = value["changedFiles"];
  if (
    typeof summary !== "string" ||
    summary.length === 0 ||
    !Array.isArray(changedFiles) ||
    !changedFiles.every((file): file is string => typeof file === "string")
  ) {
    throw new Error("The Fake Runtime completed result has an invalid shape.");
  }
  for (const file of changedFiles) {
    if (!isSafeRelativePath(file, workingDirectory)) {
      throw new Error("The Fake Runtime returned a changed file outside its working directory.");
    }
  }
  return { status: "completed", summary, changedFiles: [...changedFiles] };
}

function failedResult(code: string, message: string, retryable: boolean): AgentRunResult {
  return {
    status: "failed",
    summary: "Fake Runtime failed.",
    changedFiles: [],
    error: { code, message, retryable },
  };
}

function terminatedResult(status: "cancelled" | "timed-out"): AgentRunResult {
  return {
    status,
    summary: status === "cancelled" ? "Fake Runtime cancelled." : "Fake Runtime timed out.",
    changedFiles: [],
  };
}

function isSafeRelativePath(value: unknown, workingDirectory: string): value is string {
  if (typeof value !== "string" || value === "" || isAbsolute(value)) return false;
  const resolved = resolve(workingDirectory, value);
  const relativePath = relative(workingDirectory, resolved);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function sameFiles(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((file, index) => file === right[index]);
}

function sanitizeOutput(value: string, request: AgentRunRequest): string {
  let sanitized = value.replaceAll(request.workingDirectory, "<workspace>");
  for (const [key, secret] of Object.entries(request.environment)) {
    if (key === "JARVIS_FAKE_SCENARIO" || !SECRET_ENVIRONMENT_NAME.test(key)) continue;
    if (secret !== "") sanitized = sanitized.replaceAll(secret, "<redacted>");
  }
  return sanitized.replace(/(?:\/Users|\/home|\/private\/var)\/[^\s"']+/g, "<path>");
}

const SECRET_ENVIRONMENT_NAME =
  /(?:secret|token|password|passwd|credential|private[_-]?key|api[_-]?key)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FAKE_CHILD_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawn: spawnChild } = require("node:child_process");
delete process.env.__CF_USER_TEXT_ENCODING;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input || "{}");
  const emit = record => process.stdout.write(JSON.stringify(record) + "\n");
  if (request.scenario === "inspect") {
    const file = "fake-runtime-working-directory.txt";
    fs.writeFileSync(path.join(process.cwd(), file), process.cwd());
    emit({ type: "message", message: JSON.stringify({ cwd: process.cwd(), environment: process.env }) });
    emit({ type: "file-changed", path: file });
    emit({
      type: "result",
      status: "completed",
      summary: "Fake Runtime inspected its process context.",
      changedFiles: [file]
    });
    return;
  }
  if (request.scenario === "failure") {
    process.stderr.write("deterministic fake failure\n");
    process.exit(7);
  }
  if (request.scenario === "ignore-terminate" ||
      (request.scenario === "repair-ignore-terminate" && request.repair)) {
    const child = spawnChild(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { stdio: "ignore" }
    );
    const marker = request.scenario === "ignore-terminate" ? "fake-runtime-child" : "fake-runtime-repair-child";
    fs.writeFileSync(marker + ".pid", String(child.pid));
    const interrupt =
      request.scenario === "ignore-terminate"
        ? "fake-runtime-interrupt.txt"
        : "fake-runtime-repair-child-interrupt.txt";
    process.on("SIGTERM", () => fs.writeFileSync(interrupt, "graceful\n"));
    setInterval(() => {}, 1000);
    return;
  }
  if (request.scenario === "clean") {
    emit({
      type: "result",
      status: "completed",
      summary: "Fake Runtime left the worktree unchanged.",
      changedFiles: [],
    });
    return;
  }
  if (request.scenario === "stderr" || request.scenario === "noisy") process.stderr.write("deterministic stderr output\n");
  if (request.scenario === "malformed" || request.scenario === "noisy") process.stdout.write("{malformed json\n");
  if (request.scenario === "unknown" || request.scenario === "noisy") process.stdout.write(JSON.stringify({ type: "unrecognized", value: "deterministic raw stdout" }) + "\n");
  if (request.scenario === "oversized") process.stdout.write("x".repeat(131072) + "\n");
  const changedFiles = [];
  if (request.scenario === "repair" && request.repair) {
    emit({ type: "message", message: "Repair context: " + request.repairContext });
    const fix = "validation-fix.txt";
    fs.writeFileSync(path.join(process.cwd(), fix), "fixed\n");
    changedFiles.push(fix);
    emit({ type: "file-changed", path: fix });
  }
  const file = "fake-runtime-change.txt";
  fs.writeFileSync(path.join(process.cwd(), file), "Fake Runtime deterministic change.\n");
  if (!(request.scenario === "repair" && request.repair)) {
    emit({ type: "message", message: "Fake Runtime applied deterministic change." });
  }
  emit({ type: "file-changed", path: file });
  changedFiles.push(file);
  emit({
    type: "result",
    status: "completed",
    summary: "Fake Runtime applied deterministic change.",
    changedFiles
  });
});
`;
