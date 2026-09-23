import { EngineError } from "../errors.js";
import type { ModuleCapabilityRequirement } from "../../../../packages/kernel/src/module-host.js";
import type {
  ExternalMappingCapability,
  AgentRuntimeGrant,
  DevelopmentAdmissionCapability,
  GitPushCredential,
  ModuleHandlerCapabilities,
  PollCursorCapability,
  WorkItemReadinessCapability,
  ModuleWorkspace,
  WorkItemsCapability,
} from "../../../../packages/module-sdk/src/index.js";
import type {
  AgentRuntime,
  RuntimeDescriptor,
} from "../../../../packages/agent-runtime/src/index.js";
import {
  GitHubApiClient,
  GitHubApiError,
  GitHubTranslationError,
  assessGitHubWorkItemReadiness,
  observeGitHubWorkItemState,
  type GitHubCredentialResolutionPort,
  parseGitHubWorkItemRef,
  translateGitHubWorkItemResponse,
} from "../../../../packages/modules/github/src/index.js";
import { runProjectCommand } from "./project-command.js";
import type { ResolvedProjectSnapshot } from "../projects/store.js";
import type { ConnectionDescriptor } from "../connections/registry.js";
import type { WorkspaceManager } from "../../../../packages/workspace/src/workspace-manager.js";

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
  descriptor(projectId: string, ref: string): RuntimeDescriptor | undefined;
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

export interface WorkItemReadinessCapabilityResolver {
  bind(projectId: string, moduleInstanceId: string): WorkItemReadinessCapability;
}

export interface DevelopmentAdmissionCapabilityResolver {
  bind(projectId: string): DevelopmentAdmissionCapability;
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
    const repositoryPath = snapshot.bindings.repository.path;
    return {
      recover: (input) => this.manager.recover({ ...input, projectId, repositoryPath }),
      allocate: (input) =>
        this.manager.allocate({
          ...input,
          projectId,
          repositoryPath,
          project: {
            git: { branchPattern: input.policy.branchPattern },
            workspace: {
              maxConcurrentExecutions: input.policy.maxConcurrentExecutions,
              retainOnFailureDays: input.policy.retainOnFailureDays,
            },
          },
        }),
      release: async (input) => {
        await this.manager.release({
          ...input,
          projectId,
          executionId: input.executionId,
          repositoryPath,
          project: {
            git: { branchPattern: "unused-on-release" },
            workspace: {
              maxConcurrentExecutions: 1,
              retainOnFailureDays: input.policy.retainOnFailureDays,
            },
          },
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
    private readonly workItemReadiness?: WorkItemReadinessCapabilityResolver,
    private readonly developmentAdmissions?: DevelopmentAdmissionCapabilityResolver,
  ) {}

  public resolve(
    projectId: string,
    moduleInstanceId: string,
    moduleId: string,
  ): ModuleHandlerCapabilities {
    const requirements = this.modules.composition(moduleId)?.requires ?? [];
    const agentRequirement = requirements.find((candidate) => candidate.id === "agent.execute");
    const workspaceRequired = requirements.some((candidate) => candidate.id === "repository.write");
    const shellRequired = requirements.some((candidate) => candidate.id === "shell.execute");
    const githubRequirement = requirements.find((candidate) => candidate.id === "github.api");
    const workItemsRequirement = requirements.find(
      (candidate) => candidate.id === "work-items.read",
    );
    if (
      agentRequirement === undefined &&
      !workspaceRequired &&
      !shellRequired &&
      githubRequirement === undefined &&
      workItemsRequirement === undefined &&
      this.externalMappings === undefined &&
      this.pollCursors === undefined &&
      this.developmentAdmissions === undefined
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
      this.pollCursors === undefined &&
      this.developmentAdmissions === undefined
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
      ...(this.workItemReadiness === undefined ||
      (moduleId !== "jarvis.module.github" && moduleId !== "jarvis.module.development")
        ? {}
        : { workItemReadiness: this.workItemReadiness.bind(projectId, moduleInstanceId) }),
      ...(this.developmentAdmissions === undefined || moduleId !== "jarvis.module.development"
        ? {}
        : { developmentAdmission: this.developmentAdmissions.bind(projectId) }),
      ...(moduleId !== "jarvis.module.development"
        ? {}
        : {
            gitPushCredentials: {
              resolve: (repositoryId: string, remoteUrl: string) =>
                this.resolveGitPushCredential(
                  projectId,
                  moduleInstanceId,
                  snapshot,
                  repositoryId,
                  remoteUrl,
                ),
            },
          }),
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
      const descriptor = this.runtimes.descriptor(projectId, binding.ref);
      if (descriptor === undefined) {
        throw unresolvedCapability(
          projectId,
          moduleInstanceId,
          "agent.execute",
          slot,
          `runtime ${binding.ref} has no current descriptor`,
        );
      }
      resolved = {
        ...resolved,
        agentRuntime: runtime,
        revalidateAgentRuntime: () =>
          this.revalidateAgentRuntime(projectId, moduleInstanceId, slot, binding.ref, descriptor),
        projectBindings: { projectId, slots: snapshot.bindings.slots, runtimeSlot: slot },
      };
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
    if (shellRequired) resolved = { ...resolved, shell: { run: runProjectCommand } };
    const workItemsApiRequirement = githubRequirement ?? workItemsRequirement;
    if (workItemsApiRequirement !== undefined) {
      const githubApi = this.resolveGitHubApi(
        projectId,
        moduleInstanceId,
        snapshot,
        workItemsApiRequirement,
        githubRequirement === undefined ? "work-items.read" : "github.api",
      );
      if (githubApi !== undefined) {
        if (githubRequirement !== undefined) resolved = { ...resolved, githubApi };
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
          assessReadiness: async ({ ref, repositoryId, tag }) => {
            const reference = parseGitHubWorkItemRef(ref);
            if (!linkedRepository(snapshot, repositoryId, reference.owner, reference.repository)) {
              return {
                status: "impossible",
                reason: "work-item-repository-unlinked",
                blockerRefs: [],
              };
            }
            return assessGitHubWorkItemReadiness({
              api: githubApi,
              owner: reference.owner,
              repository: reference.repository,
              number: reference.number,
              tag,
            });
          },
          observeState: async (ref, repositoryId) => {
            const reference = parseGitHubWorkItemRef(ref);
            if (!linkedRepository(snapshot, repositoryId, reference.owner, reference.repository)) {
              return {
                title: "",
                state: "unknown",
                tags: [],
                dependencies: { status: "unknown", openWorkItemRefs: [] },
                verification: "unavailable",
                reasonCode: "observation-incomplete",
              };
            }
            return observeGitHubWorkItemState({
              api: githubApi,
              owner: reference.owner,
              repository: reference.repository,
              number: reference.number,
            });
          },
        };
        if (workItemsRequirement !== undefined || moduleId === "jarvis.module.github") {
          resolved = { ...resolved, workItems };
        }
      }
    }
    return resolved;
  }

  private revalidateAgentRuntime(
    projectId: string,
    moduleInstanceId: string,
    slot: string,
    ref: string,
    expectedDescriptor: RuntimeDescriptor,
  ): AgentRuntimeGrant | undefined {
    const snapshot = this.snapshots.getResolvedProject(projectId);
    const instance = snapshot?.moduleInstances.find(
      (candidate) => candidate.instanceId === moduleInstanceId,
    );
    if (snapshot === undefined || instance === undefined) return undefined;
    const currentSlot = instance.runtimeSlot;
    const binding = snapshot.bindings.slots[slot];
    if (
      currentSlot !== slot ||
      binding === undefined ||
      binding.kind !== "runtime" ||
      binding.ref !== ref
    ) {
      return undefined;
    }
    const descriptor = this.runtimes.descriptor(projectId, ref);
    if (!sameRuntimeDescriptor(descriptor, expectedDescriptor)) return undefined;
    const runtime = this.runtimes.resolve(projectId, ref);
    if (runtime === undefined) return undefined;
    return {
      runtime,
      projectBindings: { projectId, slots: snapshot.bindings.slots, runtimeSlot: slot },
    };
  }

  private resolveGitHubApi(
    projectId: string,
    moduleInstanceId: string,
    snapshot: ResolvedProjectSnapshot,
    requirement: ModuleCapabilityRequirement,
    capability: "github.api" | "work-items.read",
  ): GitHubApiClient | undefined {
    const declaredSlot = capabilitySlot(requirement, undefined);
    const inferredSlot =
      capability === "work-items.read" && snapshot.composition.compositionMode === "fixed-modules"
        ? snapshot.moduleInstances.find((instance) => instance.moduleId === "jarvis.module.github")
            ?.bindings?.["sourceControl"]
        : undefined;
    const slot =
      declaredSlot !== undefined && snapshot.bindings.slots[declaredSlot] !== undefined
        ? declaredSlot
        : (inferredSlot ?? declaredSlot);
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

  private async resolveGitPushCredential(
    projectId: string,
    moduleInstanceId: string,
    snapshot: ResolvedProjectSnapshot,
    repositoryId: string,
    remoteUrl: string,
  ): Promise<GitPushCredential | undefined> {
    const repository = snapshot.repositoryIdentities?.find(
      (identity) => identity.repositoryId === repositoryId && identity.provider === "github",
    );
    if (repository === undefined || this.githubCredentials === undefined) return undefined;

    let remote: URL;
    try {
      remote = new URL(remoteUrl);
    } catch {
      return undefined;
    }
    const remotePath = remote.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "");
    const expectedPath = `/${repository.owner}/${repository.name}`;
    if (
      remote.protocol !== "https:" ||
      remote.hostname !== "github.com" ||
      remote.port !== "" ||
      remote.username !== "" ||
      remote.password !== "" ||
      remote.search !== "" ||
      remote.hash !== "" ||
      remotePath.toLowerCase() !== expectedPath.toLowerCase()
    ) {
      return undefined;
    }

    const github = snapshot.moduleInstances.find(
      (candidate) => candidate.enabled && candidate.moduleId === "jarvis.module.github",
    );
    const slot = github?.bindings?.["sourceControl"];
    const binding = slot === undefined ? undefined : snapshot.bindings.slots[slot];
    if (binding?.kind !== "connection") return undefined;
    const connection = this.connections?.find(binding.ref);
    if (
      connection?.provider !== "github" ||
      connection.status !== "available" ||
      !connection.capabilities.includes("scm.change-request.manage")
    ) {
      return undefined;
    }
    const resolved = await this.githubCredentials.resolve(connection.secretRef);
    if (resolved.status !== "available") return undefined;
    return {
      username: "x-access-token",
      password: resolved.credential,
      remoteUrl: remoteUrl.trim(),
    };
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

function capabilitySlot(
  requirement: ModuleCapabilityRequirement,
  runtimeSlot: string | undefined,
): string | undefined {
  return requirement.binding === "agentRuntime"
    ? (runtimeSlot ?? "agentRuntime")
    : requirement.binding;
}

function sameRuntimeDescriptor(
  current: RuntimeDescriptor | undefined,
  expected: RuntimeDescriptor,
): boolean {
  return (
    current !== undefined &&
    current.id === expected.id &&
    current.provider === expected.provider &&
    current.executablePath === expected.executablePath &&
    current.version === expected.version &&
    sameCapabilities(current.capabilities, expected.capabilities)
  );
}

function sameCapabilities(current: readonly string[], expected: readonly string[]): boolean {
  return (
    current.length === expected.length &&
    current.every((capability) => expected.includes(capability))
  );
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
