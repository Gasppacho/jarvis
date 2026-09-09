import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  AgentRun,
  AgentRunEvent,
  AgentRunEventType,
  AgentRunRequest,
  AgentRunResult,
} from "./index.js";

export type AgentRunObservation =
  | {
      readonly type: Exclude<AgentRunEventType, "started" | "completed" | "failed">;
      readonly message?: string;
      readonly chunk?: string;
      readonly path?: string;
    }
  | { readonly type: "result"; readonly result: AgentRunResult };

export interface AgentRunTranslator {
  translate(line: string): readonly AgentRunObservation[];
}

export interface ChildProcessAgentRunOptions {
  readonly request: AgentRunRequest;
  readonly signal: AbortSignal;
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly translator: AgentRunTranslator;
  readonly displayName?: string;
}

const MAX_PROTOCOL_LINE_BYTES = 64 * 1024;
const FORCE_KILL_DELAY_MS = 250;
const SECRET_ENVIRONMENT_NAME =
  /(?:secret|token|password|passwd|credential|private[_-]?key|api[_-]?key)/i;

/** Owns child-process mechanics; adapters only translate framed stdout lines. */
export class ChildProcessAgentRun implements AgentRun {
  public readonly processId: number;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly eventHistory: AgentRunEvent[] = [];
  private readonly eventWaiters = new Set<() => void>();
  private readonly resultPromise: Promise<AgentRunResult>;
  private readonly observedRequest: AgentRunRequest;
  private readonly translator: AgentRunTranslator;
  private readonly displayName: string;
  private readonly signal: AbortSignal;
  private readonly abortHandler: () => void;
  private readonly timeoutTimer: NodeJS.Timeout;
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
  private processError: Error | undefined;

  public constructor(options: ChildProcessAgentRunOptions) {
    this.observedRequest = options.request;
    this.translator = options.translator;
    this.displayName = options.displayName ?? "Agent Runtime";
    this.signal = options.signal;
    this.abortHandler = () => void this.interrupt();
    this.child = spawn(options.executable, [...options.args], {
      cwd: options.request.workingDirectory,
      env: { ...options.request.environment },
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (this.child.pid === undefined) {
      throw new Error(`The ${this.displayName} child process did not expose a pid.`);
    }
    this.processId = this.child.pid;
    this.emit({ type: "started" });
    this.resultPromise = this.readResult();
    this.child.stdin.end(options.stdin);
    this.timeoutTimer = setTimeout(() => {
      void this.requestTermination("timed-out").catch(() => {});
    }, options.request.timeoutMs);
    if (options.signal.aborted) void this.interrupt();
    else options.signal.addEventListener("abort", this.abortHandler, { once: true });
  }

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
        this.signal.removeEventListener("abort", this.abortHandler);
        const finalResult =
          this.terminationReason === undefined
            ? result
            : terminatedResult(this.displayName, this.terminationReason);
        this.finish(finalResult);
        resolveResult(finalResult);
      };

      this.child.stdout.on("data", (chunk: string) => this.consumeOutput("stdout", chunk));
      this.child.stderr.on("data", (chunk: string) => this.consumeOutput("stderr", chunk));
      this.child.once("error", (error) => {
        this.processError = error;
      });
      this.child.once("close", (exitCode, signal) => {
        this.flushOutput("stdout");
        this.flushOutput("stderr");
        if (this.processError !== undefined) {
          finish(
            failedResult(this.displayName, "agent.process-error", this.processError.message, true),
          );
          return;
        }
        if (exitCode !== 0) {
          finish(
            failedResult(
              this.displayName,
              "agent.process-failed",
              `${this.displayName} exited with ${signal ?? `code ${String(exitCode)}`}.${this.stderrSummary === "" ? "" : ` ${this.stderrSummary}`}`,
              false,
            ),
          );
          return;
        }

        finish(
          this.pendingResult ??
            failedResult(
              this.displayName,
              "agent.invalid-result",
              `The ${this.displayName} closed without a result line.`,
              false,
            ),
        );
      });
    });
  }

  private consumeOutput(kind: "stdout" | "stderr", chunk: string): void {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    this.outputBytes += Buffer.byteLength(text, "utf8");
    if (this.outputBytes > this.observedRequest.outputLimitBytes && !this.outputLimitWarned) {
      this.outputLimitWarned = true;
      this.emit({
        type: "warning",
        message: `${this.displayName} output exceeded ${this.observedRequest.outputLimitBytes} bytes; raw output was truncated.`,
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
          this.emitOverlongWarning();
        }
        return;
      }

      const line = buffer.slice(0, newline).replace(/\r$/, "");
      this.setBuffer(kind, buffer.slice(newline + 1));
      this.processLine(kind, line);
    }
  }

  private flushOutput(kind: "stdout" | "stderr"): void {
    const buffer = kind === "stdout" ? this.stdoutBuffer : this.stderrBuffer;
    if (buffer !== "") {
      this.setBuffer(kind, "");
      this.processLine(kind, buffer);
    }
  }

  private setBuffer(kind: "stdout" | "stderr", value: string): void {
    if (kind === "stdout") this.stdoutBuffer = value;
    else this.stderrBuffer = value;
  }

  private processLine(kind: "stdout" | "stderr", line: string): void {
    if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
      this.emitOverlongWarning();
      return;
    }
    if (kind === "stderr") {
      const sanitized = sanitizeOutput(line, this.observedRequest);
      this.stderrSummary =
        `${this.stderrSummary}${this.stderrSummary === "" ? "" : " "}${sanitized}`.slice(0, 4096);
      this.emitCaptured("stderr", line);
      return;
    }

    try {
      for (const observation of this.translator.translate(line)) this.emitObservation(observation);
    } catch (error) {
      this.pendingResult = failedResult(
        this.displayName,
        "agent.protocol-error",
        error instanceof Error
          ? sanitizeOutput(error.message, this.observedRequest)
          : "Protocol translation failed.",
        false,
      );
    }
  }

  private emitOverlongWarning(): void {
    this.emit({
      type: "warning",
      message: `${this.displayName} discarded an overlong protocol line.`,
    });
  }

  private emitObservation(observation: AgentRunObservation): void {
    if (observation.type === "result") {
      this.pendingResult = sanitizeResult(observation.result, this.observedRequest);
      return;
    }

    const message =
      observation.message === undefined
        ? undefined
        : observation.type === "warning"
          ? sanitizeOutput(observation.message, this.observedRequest)
          : this.captureOutput(sanitizeOutput(observation.message, this.observedRequest));
    const chunk =
      observation.chunk === undefined
        ? undefined
        : observation.type === "warning"
          ? sanitizeOutput(observation.chunk, this.observedRequest)
          : this.captureOutput(sanitizeOutput(observation.chunk, this.observedRequest));
    const path =
      observation.path === undefined
        ? undefined
        : sanitizeOutput(observation.path, this.observedRequest);
    this.emit({
      type: observation.type,
      ...(message === undefined ? {} : { message }),
      ...(chunk === undefined ? {} : { chunk }),
      ...(path === undefined ? {} : { path }),
    });
  }

  private emitCaptured(type: "stdout" | "stderr", value: string): void {
    const visible = this.captureOutput(sanitizeOutput(value, this.observedRequest));
    if (visible !== "") this.emit({ type, chunk: visible });
  }

  private captureOutput(value: string): string {
    const bytes = Buffer.from(value, "utf8");
    const remaining = Math.max(
      0,
      Math.floor(this.observedRequest.outputLimitBytes - this.capturedOutputBytes),
    );
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function failedResult(
  displayName: string,
  code: string,
  message: string,
  retryable: boolean,
): AgentRunResult {
  return {
    status: "failed",
    summary: `${displayName} failed.`,
    changedFiles: [],
    error: { code, message, retryable },
  };
}

function terminatedResult(displayName: string, status: "cancelled" | "timed-out"): AgentRunResult {
  return {
    status,
    summary: status === "cancelled" ? `${displayName} cancelled.` : `${displayName} timed out.`,
    changedFiles: [],
  };
}

function sanitizeResult(result: AgentRunResult, request: AgentRunRequest): AgentRunResult {
  return {
    ...result,
    summary: sanitizeOutput(result.summary, request),
    changedFiles: result.changedFiles.map((file) => sanitizeOutput(file, request)),
    ...(result.rawArtifactRef === undefined
      ? {}
      : { rawArtifactRef: sanitizeOutput(result.rawArtifactRef, request) }),
    ...(result.error === undefined
      ? {}
      : {
          error: {
            ...result.error,
            message: sanitizeOutput(result.error.message, request),
          },
        }),
  };
}

function sanitizeOutput(value: string, request: AgentRunRequest): string {
  let sanitized = value.replaceAll(request.workingDirectory, "<workspace>");
  for (const [key, secret] of Object.entries(request.environment)) {
    if (key === "JARVIS_FAKE_SCENARIO" || !SECRET_ENVIRONMENT_NAME.test(key)) continue;
    if (secret !== "") sanitized = sanitized.replaceAll(secret, "<redacted>");
  }
  return sanitized.replace(/(?:\/Users|\/home|\/private\/var)\/[^\s"']+/g, "<path>");
}
