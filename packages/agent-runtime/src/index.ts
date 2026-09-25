import { ChildProcessAgentRun } from "./child-process-agent-run.js";
import { FAKE_CHILD_SOURCE, FakeRuntimeTranslator } from "./fake-runtime-translator.js";
import type { AgentRun, AgentRunRequest, AgentRuntime, RuntimeDescriptor } from "./types.js";

export { ChildProcessAgentRun };
export type {
  AgentRun,
  AgentRunEvent,
  AgentRunEventType,
  AgentRunRequest,
  AgentRunResult,
  AgentRuntime,
  RuntimeDescriptor,
} from "./types.js";
export type {
  AgentRunObservation,
  AgentRunTranslator,
  ChildProcessFailure,
  ChildProcessFailureClassifier,
  ChildProcessAgentRunOptions,
} from "./child-process-agent-run.js";

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
    const pullRequest = request.objective.startsWith(
      "Prepare a Pull Request for the supplied work item",
    );
    const ticketContent = request.systemInstructions.find((instruction) =>
      instruction.startsWith("Ticket content ("),
    );
    super({
      request,
      signal,
      executable: process.execPath,
      args: ["-e", FAKE_CHILD_SOURCE],
      stdin: JSON.stringify({
        scenario: request.environment["JARVIS_FAKE_SCENARIO"],
        repair: repairContext !== "",
        repairContext,
        pullRequest,
        pullRequestTitle: pullRequest
          ? /^Issue \d+: ([^\n]+)/m.exec(ticketContent ?? "")?.[1]
          : undefined,
        pullRequestSummary: request.environment["JARVIS_FAKE_PR_SUMMARY"],
        pullRequestDirty: request.environment["JARVIS_FAKE_PR_DIRTY"] === "1",
      }),
      translator: new FakeRuntimeTranslator(request),
      displayName: "Fake Runtime",
    });
  }
}
