import { ChildProcessAgentRun } from "./child-process-agent-run.js";
import { FAKE_CHILD_SOURCE, FakeRuntimeTranslator } from "./fake-runtime-translator.js";

export { ChildProcessAgentRun };
export type {
  AgentRunObservation,
  AgentRunTranslator,
  ChildProcessFailure,
  ChildProcessFailureClassifier,
  ChildProcessAgentRunOptions,
} from "./child-process-agent-run.js";

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

/** Fake adapter: only supplies the child command and its protocol translator. */
export class FakeAgentRun extends ChildProcessAgentRun {
  public constructor(request: AgentRunRequest, signal: AbortSignal) {
    const repairContext =
      request.systemInstructions.find((instruction) =>
        instruction.includes("Validation failure"),
      ) ?? "";
    super({
      request,
      signal,
      executable: process.execPath,
      args: ["-e", FAKE_CHILD_SOURCE],
      stdin: JSON.stringify({
        scenario: request.environment["JARVIS_FAKE_SCENARIO"],
        repair: repairContext !== "",
        repairContext,
      }),
      translator: new FakeRuntimeTranslator(request),
      displayName: "Fake Runtime",
    });
  }
}
