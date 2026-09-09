import { EngineError } from "../errors.js";
import type { ModuleCapabilityRequirement } from "../../../../packages/kernel/src/module-host.js";
import type {
  ModuleHandlerCapabilities,
  ModuleShellCommandInput,
  ModuleShellCommandResult,
  ModuleWorkspace,
  ProjectCommandName,
  ProjectCommandsCapability,
} from "../../../../packages/module-sdk/src/index.js";
import type { AgentRuntime } from "../../../../packages/agent-runtime/src/index.js";
import { runBoundedProcess } from "../../../../packages/workspace/src/bounded-process-runner.js";
import type { ResolvedProjectSnapshot } from "../projects/store.js";
import type {
  WorkspaceManager,
  WorkspaceProjectConfiguration,
} from "../../../../packages/workspace/src/workspace-manager.js";

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

export interface ProjectWorkspaceResolver {
  resolve(projectId: string): ModuleWorkspace | undefined;
}

/** Binds the existing workspace manager to one frozen Project snapshot. */
export class ProjectWorkspaceCapabilityResolver implements ProjectWorkspaceResolver {
  public constructor(
    private readonly snapshots: ProjectSnapshotReader,
    private readonly manager: WorkspaceManager,
  ) {}

  public resolve(projectId: string): ModuleWorkspace | undefined {
    const snapshot = this.snapshots.getResolvedProject(projectId);
    if (snapshot === undefined) return undefined;
    const project: WorkspaceProjectConfiguration = {
      git: { branchPattern: snapshot.composition.git.branchPattern },
      workspace: {
        maxConcurrentExecutions: snapshot.composition.workspace.maxConcurrentExecutions,
        retainOnFailureDays: snapshot.composition.workspace.retainOnFailureDays,
      },
    };
    const repositoryPath = snapshot.bindings.repository.path;
    return {
      allocate: (input) =>
        this.manager.allocate({
          ...input,
          projectId,
          repositoryPath,
          project,
        }),
      release: async (input) => {
        await this.manager.release({
          ...input,
          projectId,
          executionId: input.executionId,
          repositoryPath,
          project,
        });
      },
    };
  }
}

/** Resolves only the capabilities declared by the addressed Module Instance. */
export class ProjectModuleCapabilityResolver {
  public constructor(
    private readonly snapshots: ProjectSnapshotReader,
    private readonly modules: ModuleCompositionReader,
    private readonly runtimes: AgentRuntimeResolver,
    private readonly workspaces?: ProjectWorkspaceResolver,
  ) {}

  public resolve(
    projectId: string,
    moduleInstanceId: string,
    moduleId: string,
  ): ModuleHandlerCapabilities {
    const requirements = this.modules.composition(moduleId)?.requires ?? [];
    const agentRequirement = requirements.find((candidate) => candidate.id === "agent.execute");
    const workspaceRequired = requirements.some((candidate) => candidate.id === "repository.write");
    const projectCommandsRequired = requirements.some(
      (candidate) => candidate.id === "shell.execute",
    );
    if (agentRequirement === undefined && !workspaceRequired && !projectCommandsRequired) return {};

    const snapshot = this.snapshots.getResolvedProject(projectId);
    if (snapshot === undefined && agentRequirement === undefined && !workspaceRequired) {
      return {};
    }
    const instance = snapshot?.moduleInstances.find(
      (candidate) => candidate.instanceId === moduleInstanceId,
    );
    if (snapshot === undefined || instance === undefined) {
      throw unresolvedCapability(
        projectId,
        moduleInstanceId,
        "agent.execute",
        "agentRuntime",
        "has no resolved Project snapshot",
      );
    }

    const capabilities: ModuleHandlerCapabilities = {
      projectBindings: { projectId, slots: snapshot.bindings.slots },
    };
    let resolved: ModuleHandlerCapabilities = capabilities;
    if (agentRequirement !== undefined) {
      const slot = capabilitySlot(agentRequirement, instance.runtimeSlot);
      if (slot === undefined) {
        throw unresolvedCapability(
          projectId,
          moduleInstanceId,
          "agent.execute",
          "agentRuntime",
          "has no bound runtime slot",
        );
      }
      const binding = snapshot.bindings.slots[slot];
      if (binding === undefined) {
        throw unresolvedCapability(
          projectId,
          moduleInstanceId,
          "agent.execute",
          slot,
          "has no Local Binding",
        );
      }
      if (binding.kind !== "runtime") {
        throw unresolvedCapability(
          projectId,
          moduleInstanceId,
          "agent.execute",
          slot,
          `is bound to ${binding.kind}/${binding.ref}, not a runtime`,
        );
      }
      const runtime = this.runtimes.resolve(projectId, binding.ref);
      if (runtime === undefined) {
        throw unresolvedCapability(
          projectId,
          moduleInstanceId,
          "agent.execute",
          slot,
          `runtime ${binding.ref} is unavailable`,
        );
      }
      resolved = { ...resolved, agentRuntime: runtime };
    }

    if (workspaceRequired) {
      const workspace = this.workspaces?.resolve(projectId);
      if (workspace === undefined) {
        throw unresolvedCapability(
          projectId,
          moduleInstanceId,
          "repository.write",
          "repository",
          "has no project workspace capability",
        );
      }
      resolved = { ...resolved, workspace };
    }
    if (projectCommandsRequired) {
      resolved = {
        ...resolved,
        projectCommands: projectCommands(snapshot.composition),
        shell: { run: runProjectCommand },
      };
    }
    return resolved;
  }
}

function runProjectCommand(input: ModuleShellCommandInput): Promise<ModuleShellCommandResult> {
  const windows = process.platform === "win32";
  return runBoundedProcess({
    executable: windows ? "cmd.exe" : "/bin/sh",
    args: windows ? ["/d", "/s", "/c", input.command] : ["-c", input.command],
    cwd: input.cwd,
    env: {
      PATH: process.env["PATH"] ?? "",
      LANG: "C",
      LC_ALL: "C",
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.outputLimitBytes === undefined ? {} : { outputLimitBytes: input.outputLimitBytes }),
  });
}

function projectCommands(
  composition: ResolvedProjectSnapshot["composition"],
): ProjectCommandsCapability {
  const commands: Partial<Record<ProjectCommandName, string>> = {};
  for (const name of ["install", "lint", "typecheck", "test", "build"] as const) {
    const command = composition.commands[name];
    if (typeof command === "string") commands[name] = command;
  }
  return {
    commands,
    git: {
      branchPattern: composition.git.branchPattern,
      commitStrategy: composition.git.commitStrategy,
      pushRemote: composition.git.pushRemote,
      ...(composition.git.allowForcePush === undefined
        ? {}
        : { allowForcePush: composition.git.allowForcePush }),
    },
  };
}

function capabilitySlot(
  requirement: ModuleCapabilityRequirement,
  runtimeSlot: string | undefined,
): string | undefined {
  return requirement.binding === "agentRuntime"
    ? (runtimeSlot ?? "agentRuntime")
    : requirement.binding;
}

function unresolvedCapability(
  projectId: string,
  moduleInstanceId: string,
  capability: string,
  slot: string,
  reason: string,
): EngineError {
  return new EngineError(
    "project.capability-unresolved",
    409,
    `Project ${projectId} cannot resolve ${capability} for Module Instance ${moduleInstanceId} at Slot ${slot}: ${reason}.`,
    { projectId, moduleInstanceId, slot, capability },
  );
}
