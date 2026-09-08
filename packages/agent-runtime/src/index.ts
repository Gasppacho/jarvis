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
  private readonly resultPromise: Promise<AgentRunResult>;

  public constructor(
    private readonly request: AgentRunRequest,
    signal: AbortSignal,
  ) {
    this.child = spawn(process.execPath, ["-e", FAKE_CHILD_SOURCE], {
      cwd: request.workingDirectory,
      env: { ...request.environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (this.child.pid === undefined) {
      throw new Error("The Fake Runtime child process did not expose a pid.");
    }
    this.processId = this.child.pid;
    this.resultPromise = this.readResult();
    this.child.stdin.end(JSON.stringify({ scenario: request.environment["JARVIS_FAKE_SCENARIO"] }));
    if (signal.aborted) void this.interrupt();
    else signal.addEventListener("abort", () => void this.interrupt(), { once: true });
  }

  public async *events(): AsyncIterable<AgentRunEvent> {
    await this.result();
  }

  public result(): Promise<AgentRunResult> {
    return this.resultPromise;
  }

  public async interrupt(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
    }
    await this.resultPromise;
  }

  private readResult(): Promise<AgentRunResult> {
    let stdout = "";
    let stderr = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    this.child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    return new Promise((resolveResult) => {
      this.child.once("error", (error) =>
        resolveResult(failedResult("agent.process-error", error.message, true)),
      );
      this.child.once("close", (exitCode, signal) => {
        if (exitCode !== 0) {
          resolveResult(
            failedResult(
              "agent.process-failed",
              `Fake Runtime exited with ${signal ?? `code ${String(exitCode)}`}.${stderr.trim() === "" ? "" : ` ${stderr.trim()}`}`,
              false,
            ),
          );
          return;
        }

        try {
          const parsed = JSON.parse(stdout) as unknown;
          resolveResult(readCompletedResult(parsed, this.request.workingDirectory));
        } catch (error) {
          resolveResult(
            failedResult(
              "agent.invalid-result",
              error instanceof Error ? error.message : String(error),
              false,
            ),
          );
        }
      });
    });
  }
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
    if (isAbsolute(file) || relative(workingDirectory, resolve(workingDirectory, file)).startsWith("..")) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FAKE_CHILD_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input || "{}");
  if (request.scenario === "failure") {
    process.stderr.write("deterministic fake failure");
    process.exit(7);
  }
  const file = "fake-runtime-change.txt";
  fs.writeFileSync(path.join(process.cwd(), file), "Fake Runtime deterministic change.\n");
  process.stdout.write(JSON.stringify({
    status: "completed",
    summary: "Fake Runtime applied deterministic change.",
    changedFiles: [file]
  }));
});
`;
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
