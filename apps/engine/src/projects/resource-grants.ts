import type {
  ProjectResourceCandidate,
  ProjectResourceGrantPort,
} from "../../../../packages/project-runtime/src/project-types.js";
import { FakeRuntime, type AgentRuntime } from "../../../../packages/agent-runtime/src/index.js";

export const FAKE_RUNTIME_REF = "runtime/fake-test";

export const FAKE_RUNTIME_CANDIDATE: ProjectResourceCandidate = {
  ref: FAKE_RUNTIME_REF,
  kind: "runtime",
  displayName: "Fake Runtime",
  capabilities: ["agent.execute"],
};

/** Until connection/runtime/MCP registries land, no global resource is granted implicitly. */
export class EmptyProjectResourceGrants implements ProjectResourceGrantPort {
  grantedToProject(_projectId: string): readonly ProjectResourceCandidate[] {
    return [];
  }
}

/** Local runtimes are candidates only after the Project binds their Slot. */
export class LocalAgentRuntimeRegistry implements ProjectResourceGrantPort {
  private readonly fakeRuntime = new FakeRuntime();

  public grantedToProject(_projectId: string): readonly ProjectResourceCandidate[] {
    return [FAKE_RUNTIME_CANDIDATE];
  }

  public resolve(_projectId: string, ref: string): AgentRuntime | undefined {
    return ref === FAKE_RUNTIME_REF ? this.fakeRuntime : undefined;
  }
}
