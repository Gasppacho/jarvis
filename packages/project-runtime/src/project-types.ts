/** Project Runtime-owned shapes aligned with the v1 machine contracts. */

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
}

/** A discovered draft is intentionally partial until configuration replacement. */
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
