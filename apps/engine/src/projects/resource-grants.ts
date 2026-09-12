import { isAbsolute } from "node:path";
import { EngineError } from "../errors.js";
import type { ConnectionDescriptor } from "../connections/registry.js";
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

export type ProjectResourceGrantStatus =
  "available" | "unavailable" | "unauthenticated" | "degraded" | "revoked";

export interface ProjectResourceGrant {
  readonly candidate: ProjectResourceCandidate;
  readonly status?: ProjectResourceGrantStatus;
}

export interface ProjectResourceGrantDetailsPort {
  grantedResourceDetails(projectId: string): readonly ProjectResourceGrant[];
}

/** Composes the project-scoped grants exposed by each global resource source. */
export class ProjectResourceGrantAggregate
  implements ProjectResourceGrantPort, ProjectResourceGrantDetailsPort
{
  public constructor(private readonly sources: readonly ProjectResourceGrantDetailsPort[] = []) {}

  public grantedToProject(projectId: string): readonly ProjectResourceCandidate[] {
    return this.grantedResourceDetails(projectId)
      .filter(({ status }) => status === undefined || status === "available")
      .map(({ candidate }) => candidate);
  }

  public grantedResourceDetails(projectId: string): readonly ProjectResourceGrant[] {
    const grants = this.sources.flatMap((source) => source.grantedResourceDetails(projectId));
    const claimed = new Set<string>();
    for (const { candidate } of grants) {
      const key = resourceKey(candidate);
      if (claimed.has(key)) {
        throw new EngineError(
          "system.internal-error",
          500,
          `Project resource grant conflict: multiple sources claim ${key}.`,
        );
      }
      claimed.add(key);
    }
    return [...grants].sort(compareGrants);
  }
}

interface RuntimeDescriptorReader {
  list(): readonly RuntimeDescriptor[];
}

function resourceKey(candidate: ProjectResourceCandidate): string {
  return `${candidate.kind}/${candidate.ref}`;
}

function compareGrants(left: ProjectResourceGrant, right: ProjectResourceGrant): number {
  return resourceKey(left.candidate).localeCompare(resourceKey(right.candidate));
}

/** Reserved fallback for projects that have no global resource sources wired. */
export class EmptyProjectResourceGrants implements ProjectResourceGrantPort {
  grantedToProject(_projectId: string): readonly ProjectResourceCandidate[] {
    return [];
  }
}

/** Local runtimes are candidates only after the Project binds their Slot. */
export class LocalAgentRuntimeRegistry
  implements ProjectResourceGrantPort, ProjectResourceGrantDetailsPort
{
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

  public descriptor(_projectId: string, ref: string): RuntimeDescriptor | undefined {
    if (ref === FAKE_RUNTIME_REF) {
      return {
        id: FAKE_RUNTIME_REF,
        provider: "fake",
        displayName: FAKE_RUNTIME_CANDIDATE.displayName,
        executablePath: null,
        version: null,
        capabilities: [...FAKE_RUNTIME_CANDIDATE.capabilities],
        status: "available",
      };
    }
    return this.runtimes?.list().find((candidate) => candidate.id === ref);
  }
}

/** Global GitHub connections become Project candidates only through this source. */
export class ConnectionGrantSource implements ProjectResourceGrantDetailsPort {
  public constructor(private readonly connections?: Pick<ConnectionDescriptorReader, "list">) {}

  public grantedResourceDetails(_projectId: string): readonly ProjectResourceGrant[] {
    return (this.connections?.list() ?? []).map((descriptor) => ({
      candidate: {
        ref: descriptor.id,
        kind: "connection" as const,
        displayName: descriptor.accountLabel,
        capabilities: [...descriptor.capabilities],
      },
      status: descriptor.status,
    }));
  }
}

interface ConnectionDescriptorReader {
  list(): readonly ConnectionDescriptor[];
}
