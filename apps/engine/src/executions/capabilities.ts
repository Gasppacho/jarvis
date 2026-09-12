import { EngineError } from "../errors.js";
import type { ModuleCapabilityRequirement } from "../../../../packages/kernel/src/module-host.js";
import type {
  ExternalMappingCapability,
  ModuleHandlerCapabilities,
  ModuleShellCommandInput,
  ModuleShellCommandResult,
  PollCursorCapability,
  ModuleWorkspace,
  ProjectCommandName,
  ProjectCommandsCapability,
  WorkItemsCapability,
} from "../../../../packages/module-sdk/src/index.js";
import type { AgentRuntime } from "../../../../packages/agent-runtime/src/index.js";
import {
  GitHubApiClient,
  GitHubApiError,
  GitHubTranslationError,
  type GitHubCredentialResolutionPort,
  parseGitHubWorkItemRef,
  translateGitHubWorkItemResponse,
} from "../../../../packages/modules/github/src/index.js";
import { runBoundedProcess } from "../../../../packages/workspace/src/bounded-process-runner.js";
import type { ResolvedProjectSnapshot } from "../projects/store.js";
import type { ConnectionDescriptor } from "../connections/registry.js";
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

export interface ProjectConnectionResolver {
  find(id: string): ConnectionDescriptor | undefined;
}

export interface ExternalMappingCapabilityResolver {
  bind(projectId: string, moduleInstanceId: string): ExternalMappingCapability;
}

export interface PollCursorCapabilityResolver {
  bind(projectId: string, moduleInstanceId: string): PollCursorCapability;
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
    private readonly connections?: ProjectConnectionResolver,
    private readonly githubCredentials?: GitHubCredentialResolutionPort,
    private readonly githubApiBaseUrl?: string,
    private readonly externalMappings?: ExternalMappingCapabilityResolver,
    private readonly pollCursors?: PollCursorCapabilityResolver,
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
    const githubRequirement = requirements.find((candidate) => candidate.id === "github.api");
    const workItemsRequirement = requirements.find(
      (candidate) => candidate.id === "work-items.read",
    );
    if (
      agentRequirement === undefined &&
      !workspaceRequired &&
      !projectCommandsRequired &&
      githubRequirement === undefined &&
      workItemsRequirement === undefined &&
      this.externalMappings === undefined &&
      this.pollCursors === undefined
    ) {
      return {};
    }

    const snapshot = this.snapshots.getResolvedProject(projectId);
    if (
      snapshot === undefined &&
      agentRequirement === undefined &&
      !workspaceRequired &&
      githubRequirement === undefined &&
      workItemsRequirement === undefined &&
      this.externalMappings === undefined &&
      this.pollCursors === undefined
    ) {
      return {};
    }
    const instance = snapshot?.moduleInstances.find(
      (candidate) => candidate.instanceId === moduleInstanceId,
    );
    if (snapshot === undefined || instance === undefined) {
      const requirement = agentRequirement ?? githubRequirement ?? workItemsRequirement;
      throw unresolvedCapability(
        projectId,
        moduleInstanceId,
        requirement?.id ?? "external.mapping",
        requirement?.binding ?? (workspaceRequired ? "repository" : "engine"),
        "has no resolved Project snapshot",
      );
    }

    const capabilities: ModuleHandlerCapabilities = {
      projectBindings: { projectId, slots: snapshot.bindings.slots },
      ...(this.externalMappings === undefined
        ? {}
        : { externalMappings: this.externalMappings.bind(projectId, moduleInstanceId) }),
      ...(this.pollCursors === undefined
        ? {}
        : { pollCursor: this.pollCursors.bind(projectId, moduleInstanceId) }),
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
    if (githubRequirement !== undefined) {
      const githubApi = this.resolveGitHubApi(
        projectId,
        moduleInstanceId,
        snapshot,
        githubRequirement,
        "github.api",
      );
      if (githubApi !== undefined) resolved = { ...resolved, githubApi };
    }
    if (workItemsRequirement !== undefined) {
      const githubApi = this.resolveGitHubApi(
        projectId,
        moduleInstanceId,
        snapshot,
        workItemsRequirement,
        "work-items.read",
      );
      if (githubApi !== undefined) {
        const workItems: WorkItemsCapability = {
          read: async (ref, repositoryId) => {
            const reference = parseGitHubWorkItemRef(ref);
            if (!linkedRepository(snapshot, repositoryId, reference.owner, reference.repository)) {
              throw new GitHubTranslationError(
                "github.work-item-read-failed",
                "The requested Work Item repository is not linked to this Project repository.",
                false,
              );
            }
            let response;
            try {
              response = await githubApi.get(
                `/repos/${reference.owner}/${reference.repository}/issues/${reference.number}`,
              );
            } catch (error: unknown) {
              if (error instanceof GitHubApiError) {
                throw new GitHubTranslationError(
                  error.status === "unavailable"
                    ? "github.work-item-unavailable"
                    : "github.work-item-unauthorized",
                  error.status === "unavailable"
                    ? "GitHub Work Item service is temporarily unavailable; retry later."
                    : "GitHub cannot access the requested Work Item.",
                  error.status === "unavailable",
                );
              }
              throw error;
            }
            return translateGitHubWorkItemResponse(response, ref);
          },
        };
        resolved = { ...resolved, workItems };
      }
    }
    return resolved;
  }

  private resolveGitHubApi(
    projectId: string,
    moduleInstanceId: string,
    snapshot: ResolvedProjectSnapshot,
    requirement: ModuleCapabilityRequirement,
    capability: "github.api" | "work-items.read",
  ): GitHubApiClient | undefined {
    const slot = capabilitySlot(requirement, undefined);
    if (slot === undefined) {
      return unresolvedOrAbsent(
        requirement,
        projectId,
        moduleInstanceId,
        capability,
        "sourceControl",
        "has no bound connection slot",
      );
    }
    const binding = snapshot.bindings.slots[slot];
    if (binding === undefined) {
      return unresolvedOrAbsent(
        requirement,
        projectId,
        moduleInstanceId,
        capability,
        slot,
        "has no Local Binding",
      );
    }
    if (binding.kind !== "connection") {
      return unresolvedOrAbsent(
        requirement,
        projectId,
        moduleInstanceId,
        capability,
        slot,
        `is bound to ${binding.kind}/${binding.ref}, not a connection`,
      );
    }
    const connection = this.connections?.find(binding.ref);
    if (connection === undefined) {
      return unresolvedOrAbsent(
        requirement,
        projectId,
        moduleInstanceId,
        capability,
        slot,
        `connection ${binding.ref} is unavailable`,
      );
    }
    if (connection.provider !== "github") {
      return unresolvedOrAbsent(
        requirement,
        projectId,
        moduleInstanceId,
        capability,
        slot,
        `connection ${binding.ref} is provided by ${connection.provider}, not GitHub`,
      );
    }
    if (connection.status !== "available") {
      return unresolvedOrAbsent(
        requirement,
        projectId,
        moduleInstanceId,
        capability,
        slot,
        `connection ${binding.ref} is ${connection.status}`,
      );
    }
    if (!connection.capabilities.includes(capability)) {
      return unresolvedOrAbsent(
        requirement,
        projectId,
        moduleInstanceId,
        capability,
        slot,
        `connection ${binding.ref} does not provide ${capability}`,
      );
    }
    if (this.githubCredentials === undefined) {
      return unresolvedOrAbsent(
        requirement,
        projectId,
        moduleInstanceId,
        capability,
        slot,
        "the GitHub credential resolver is unavailable",
      );
    }
    return new GitHubApiClient({
      secretRef: connection.secretRef,
      credentialResolver: this.githubCredentials,
      ...(this.githubApiBaseUrl === undefined ? {} : { apiBaseUrl: this.githubApiBaseUrl }),
    });
  }
}

function linkedRepository(
  snapshot: ResolvedProjectSnapshot,
  repositoryId: string | undefined,
  owner: string,
  repository: string,
): boolean {
  const identities = snapshot.repositoryIdentities;
  if (identities === undefined) return false;
  return identities.some(
    (identity) =>
      identity.provider === "github" &&
      (repositoryId === undefined || identity.repositoryId === repositoryId) &&
      identity.owner.toLowerCase() === owner.toLowerCase() &&
      identity.name.toLowerCase() === repository.toLowerCase(),
  );
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

function unresolvedOrAbsent(
  requirement: ModuleCapabilityRequirement,
  projectId: string,
  moduleInstanceId: string,
  capability: string,
  slot: string,
  reason: string,
): undefined {
  if (requirement.optional) return undefined;
  throw unresolvedCapability(projectId, moduleInstanceId, capability, slot, reason);
}
