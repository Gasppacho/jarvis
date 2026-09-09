import { isAbsolute } from "node:path";
import type {
  ProjectResourceCandidate,
  ProjectResourceGrantPort,
} from "../../../../packages/project-runtime/src/project-types.js";
import { CodexRuntime } from "../../../../packages/agent-runtime/src/codex-runtime.js";
import {
  FakeRuntime,
  type AgentRuntime,
  type RuntimeDescriptor,
} from "../../../../packages/agent-runtime/src/index.js";

export const FAKE_RUNTIME_REF = "runtime/fake-test";

export const FAKE_RUNTIME_CANDIDATE: ProjectResourceCandidate = {
  ref: FAKE_RUNTIME_REF,
  kind: "runtime",
  displayName: "Fake Runtime",
  capabilities: ["agent.execute"],
};

export interface ProjectResourceGrant {
  readonly candidate: ProjectResourceCandidate;
  readonly status?: RuntimeDescriptor["status"];
}

export interface ProjectResourceGrantDetailsPort {
  grantedResourceDetails(projectId: string): readonly ProjectResourceGrant[];
}

interface RuntimeDescriptorReader {
  list(): readonly RuntimeDescriptor[];
}

/** Until connection/runtime/MCP registries land, no global resource is granted implicitly. */
export class EmptyProjectResourceGrants implements ProjectResourceGrantPort {
  grantedToProject(_projectId: string): readonly ProjectResourceCandidate[] {
    return [];
  }
}

/** Local runtimes are candidates only after the Project binds their Slot. */
export class LocalAgentRuntimeRegistry implements ProjectResourceGrantPort {
  private readonly fakeRuntime = new FakeRuntime();

  public constructor(private readonly runtimes?: RuntimeDescriptorReader) {}

  public grantedToProject(projectId: string): readonly ProjectResourceCandidate[] {
    return this.grantedResourceDetails(projectId)
      .filter(({ status }) => status === "available")
      .map(({ candidate }) => candidate);
  }

  public grantedResourceDetails(_projectId: string): readonly ProjectResourceGrant[] {
    const descriptors = this.runtimes?.list() ?? [
      {
        id: FAKE_RUNTIME_REF,
        provider: "fake",
        displayName: FAKE_RUNTIME_CANDIDATE.displayName,
        executablePath: null,
        version: null,
        capabilities: [...FAKE_RUNTIME_CANDIDATE.capabilities],
        status: "available",
      },
    ];
    return descriptors.map((descriptor) => ({
      candidate: {
        ref: descriptor.id,
        kind: "runtime",
        displayName: descriptor.displayName,
        capabilities: [...descriptor.capabilities],
      },
      status: descriptor.status,
    }));
  }

  public resolve(_projectId: string, ref: string): AgentRuntime | undefined {
    if (ref === FAKE_RUNTIME_REF) return this.fakeRuntime;
    const descriptor = this.runtimes?.list().find((candidate) => candidate.id === ref);
    if (
      descriptor?.provider !== "codex" ||
      descriptor.status !== "available" ||
      descriptor.executablePath === null ||
      !isAbsolute(descriptor.executablePath)
    ) {
      return undefined;
    }
    return new CodexRuntime(descriptor.executablePath);
  }
}
