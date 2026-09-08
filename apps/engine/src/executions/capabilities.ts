import { EngineError } from "../errors.js";
import type {
  ModuleCapabilityRequirement,
} from "../../../../packages/kernel/src/module-host.js";
import type { ModuleHandlerCapabilities } from "../../../../packages/module-sdk/src/index.js";
import type { AgentRuntime } from "../../../../packages/agent-runtime/src/index.js";
import type { ResolvedProjectSnapshot } from "../projects/store.js";

export interface ProjectSnapshotReader {
  getResolvedProject(projectId: string): ResolvedProjectSnapshot | undefined;
}

export interface ModuleCompositionReader {
  composition(
    moduleId: string,
  ): { readonly requires: readonly ModuleCapabilityRequirement[] } | undefined;
}

export interface AgentRuntimeResolver {
  resolve(projectId: string, ref: string): AgentRuntime | undefined;
}

/** Resolves only the capabilities declared by the addressed Module Instance. */
export class ProjectModuleCapabilityResolver {
  public constructor(
    private readonly snapshots: ProjectSnapshotReader,
    private readonly modules: ModuleCompositionReader,
    private readonly runtimes: AgentRuntimeResolver,
  ) {}

  public resolve(
    projectId: string,
    moduleInstanceId: string,
    moduleId: string,
  ): ModuleHandlerCapabilities {
    const requirement = this.modules
      .composition(moduleId)
      ?.requires.find((candidate) => candidate.id === "agent.execute");
    if (requirement === undefined) return {};

    const snapshot = this.snapshots.getResolvedProject(projectId);
    const instance = snapshot?.moduleInstances.find(
      (candidate) => candidate.instanceId === moduleInstanceId,
    );
    const slot = capabilitySlot(requirement, instance?.runtimeSlot);
    if (snapshot === undefined || instance === undefined || slot === undefined) {
      throw unresolved(
        projectId,
        moduleInstanceId,
        slot ?? "agentRuntime",
        "has no bound runtime slot",
      );
    }

    const binding = snapshot.bindings.slots[slot];
    if (binding === undefined) {
      throw unresolved(projectId, moduleInstanceId, slot, "has no Local Binding");
    }
    if (binding.kind !== "runtime") {
      throw unresolved(
        projectId,
        moduleInstanceId,
        slot,
        `is bound to ${binding.kind}/${binding.ref}, not a runtime`,
      );
    }

    const runtime = this.runtimes.resolve(projectId, binding.ref);
    if (runtime === undefined) {
      throw unresolved(projectId, moduleInstanceId, slot, `runtime ${binding.ref} is unavailable`);
    }
    return { agentRuntime: runtime };
  }
}

function capabilitySlot(
  requirement: ModuleCapabilityRequirement,
  runtimeSlot: string | undefined,
): string | undefined {
  return requirement.binding === "agentRuntime"
    ? (runtimeSlot ?? "agentRuntime")
    : requirement.binding;
}

function unresolved(
  projectId: string,
  moduleInstanceId: string,
  slot: string,
  reason: string,
): EngineError {
  return new EngineError(
    "project.capability-unresolved",
    409,
    `Project ${projectId} cannot resolve agent.execute for Module Instance ${moduleInstanceId} at Slot ${slot}: ${reason}.`,
    { projectId, moduleInstanceId, slot, capability: "agent.execute" },
  );
}
