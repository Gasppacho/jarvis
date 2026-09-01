/**
 * Project Runtime-owned configuration and binding shapes.
 * Machine-readable JSON Schemas remain the validation source of truth.
 */

export interface SuggestedProjectConfig {
  readonly apiVersion: "jarvis.dev/project/v1";
  readonly kind: "Project";
  readonly metadata: {
    readonly id: string;
    readonly name: string;
  };
  readonly repositories: {
    readonly id: "main";
    /** Relative: Portable Configuration is committed to the repository. */
    readonly root: ".";
    readonly defaultBranch?: string;
    readonly remote?: string;
  }[];
  readonly commands: Record<string, string>;
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

/** A discovered draft is partial until the Project Wizard completes it. */
export interface PortableProjectConfig {
  readonly apiVersion?: string;
  readonly kind?: string;
  readonly metadata?: {
    readonly id?: string;
    readonly name?: string;
    readonly description?: string;
  };
  readonly repositories?: {
    readonly id: string;
    readonly root: string;
    readonly defaultBranch?: string;
    readonly remote?: string;
  }[];
  readonly slots?: Record<string, unknown>;
  readonly commands?: Record<string, string>;
  readonly git?: Record<string, unknown>;
  readonly workspace?: Record<string, unknown>;
  readonly modules?: Record<string, unknown>[];
}

/** Local resolution status for repository bindings on this machine. */
export interface BindingStatus {
  readonly [repositoryId: string]: {
    readonly path: string;
    readonly accessible: boolean;
    readonly bookmarkRef: string | null;
  };
}
