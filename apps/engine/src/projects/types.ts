import type { components } from "../api/generated/local-api.js";

/**
 * The draft portable configuration discovery proposes (`.jarvis/project.yaml`,
 * minus the `slots` and `modules` the wizard fills in — tickets 04/05).
 * docs/architecture/PROJECTS.md: the portable config never carries absolute
 * paths, secrets or machine-specific identifiers.
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
    /** Relative: the portable config is committed to the repository. */
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

/**
 * The portable config as persisted on a project and returned in `ProjectDetail`.
 * A committed `.jarvis/project.yaml` satisfies the full project-config.v1 schema;
 * an inferred draft is a partial document the wizard completes, so every section
 * is optional here.
 */
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

/** Where the local bindings resolve the repository on this machine, live. */
export interface BindingStatus {
  readonly [repositoryId: string]: {
    readonly path: string;
    readonly accessible: boolean;
  };
}

/** The full project state machine of contracts/schemas/…/project-config (OpenAPI enum). */
export type ProjectStatus = components["schemas"]["ProjectSummary"]["status"];

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly moduleCount: number;
  readonly activeExecutions: number;
}

export interface ProjectDetail extends ProjectSummary {
  readonly portableConfig: PortableProjectConfig;
  readonly bindingStatus: BindingStatus;
}

/**
 * The contract types `suggested` as a free-form object; this is the shape the
 * wizard actually consumes. The wire JSON is identical.
 */
export type RepositoryDiscovery = Omit<
  components["schemas"]["RepositoryDiscovery"],
  "suggested"
> & {
  readonly suggested: SuggestedProjectConfig;
};
