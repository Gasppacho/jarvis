/** Project Runtime-owned shapes aligned with the v1 machine contracts. */

export type ProjectResourceKind = "connection" | "runtime" | "mcp" | "module-instance" | "engine";

/** A resource explicitly inside one Project's authority boundary. */
export interface ProjectResourceCandidate {
  readonly ref: string;
  readonly kind: ProjectResourceKind;
  readonly displayName: string;
  readonly capabilities: readonly string[];
}

/** Project Runtime port exposing only candidates eligible inside one Project. */
export interface ProjectResourceCandidateRegistry {
  listProjectResourceCandidates(projectId: unknown): readonly ProjectResourceCandidate[];
}

/** Global registries expose only resources explicitly granted to one Project. */
export interface ProjectResourceGrantPort {
  grantedToProject(projectId: string): readonly ProjectResourceCandidate[];
}

export interface SuggestedProjectConfig {
  readonly apiVersion: "jarvis.dev/project/v1";
  readonly kind: "Project";
  readonly metadata: {
    readonly id: string;
    readonly name: string;
  };
  readonly repositories: readonly {
    readonly id: "main";
    /** Relative: Portable Configuration is committed to the repository. */
    readonly root: ".";
    readonly defaultBranch?: string;
    readonly remote?: string;
  }[];
  readonly commands: Readonly<Record<string, string>>;
  readonly git: {
    readonly branchPattern: string;
    readonly commitStrategy: "conventional";
    readonly pushRemote: string;
    readonly allowForcePush: false;
  };
  readonly workspace: {
    readonly strategy: "git-worktree";
    readonly maxConcurrentExecutions: number;
    readonly retainOnFailureDays: number;
  };
  /** Composition starts empty, but the engine still owns the complete editable draft. */
  readonly slots: Readonly<Record<string, never>>;
  readonly modules: readonly [];
}

/** A discovered draft is complete except for user-selected composition. */
export type PortableProjectDraft = SuggestedProjectConfig;

export interface ProjectMetadata {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface ProjectRepositoryConfiguration {
  readonly id: "main";
  readonly root: ".";
  readonly defaultBranch: string;
  readonly remote: string;
}

export interface ProjectSlotRequirement {
  readonly requires: string;
  readonly optional?: boolean;
  readonly description?: string;
}

export interface ProjectModuleInstanceConfiguration {
  readonly instanceId: string;
  readonly moduleId: string;
  readonly enabled: boolean;
  readonly runtimeSlot?: string;
  readonly bindings?: Readonly<Record<string, string>>;
  readonly configuration?: Readonly<Record<string, unknown>>;
}

export interface PortableProjectConfiguration {
  readonly apiVersion: "jarvis.dev/project/v1";
  readonly kind: "Project";
  readonly metadata: ProjectMetadata;
  readonly repositories: readonly ProjectRepositoryConfiguration[];
  readonly slots: Readonly<Record<string, ProjectSlotRequirement>>;
  readonly commands: Readonly<
    Partial<Record<"install" | "lint" | "typecheck" | "test" | "build", string>>
  >;
  readonly git: {
    readonly branchPattern: string;
    readonly commitStrategy: "conventional" | "ticket-prefix" | "freeform";
    readonly pushRemote: string;
    readonly allowForcePush?: false;
  };
  readonly workspace: {
    readonly strategy: "git-worktree";
    readonly maxConcurrentExecutions: number;
    readonly retainOnFailureDays: number;
  };
  readonly modules: readonly ProjectModuleInstanceConfiguration[];
}

/** Rows imported before wizard completion retain their partial discovery draft. */
export type StoredPortableProjectConfiguration =
  PortableProjectConfiguration | PortableProjectDraft;

export interface ProjectRepositoryBinding {
  readonly path: string;
  readonly bookmarkRef: string | null;
}

export interface ProjectSlotBinding {
  readonly kind: "connection" | "runtime" | "mcp" | "module-instance" | "engine";
  /** Opaque local identifier; it does not prove that the resource exists. */
  readonly ref: string;
}

export interface ProjectBindings {
  readonly apiVersion: "jarvis.dev/project-bindings/v1";
  readonly kind: "ProjectBindings";
  readonly projectId: string;
  readonly repositories: Readonly<Record<string, ProjectRepositoryBinding>>;
  readonly slots: Readonly<Record<string, ProjectSlotBinding>>;
}

/** Live repository resolution status exposed on Project Detail. */
export interface BindingStatus {
  readonly [repositoryId: string]: {
    readonly path: string;
    readonly accessible: boolean;
    readonly bookmarkRef: string | null;
  };
}
