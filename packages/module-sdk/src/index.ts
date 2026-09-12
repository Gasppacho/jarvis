import type {
  EventEnvelope,
  EventEnvelopeMetadata,
  EventEnvelopeSubject,
  EventEnvelopeTarget,
} from "../../eventing/src/envelope.js";
import type { AgentRuntime } from "../../agent-runtime/src/index.js";
import type { AgentProjectBindings } from "../../agent-runtime/src/request-builder.js";

export type ModuleConfiguration = Readonly<Record<string, unknown>>;

export type ProjectCommandName = "install" | "lint" | "typecheck" | "test" | "build";

export interface ProjectCommandsCapability {
  readonly commands: Readonly<Partial<Record<ProjectCommandName, string>>>;
  readonly git: {
    readonly branchPattern: string;
    readonly commitStrategy: "conventional" | "ticket-prefix" | "freeform";
    readonly pushRemote: string;
    readonly allowForcePush?: false;
  };
}

export interface ModuleShellCommandInput {
  readonly command: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
}

export type ModuleShellCommandResult =
  | {
      readonly ok: true;
      readonly exitCode: 0;
      readonly stdout: string;
      readonly stderr: string;
      readonly outputTruncated: boolean;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly exitCode: number | null;
      readonly stdout: string;
      readonly stderr: string;
      readonly outputTruncated: boolean;
    };

export interface ModuleShell {
  run(input: ModuleShellCommandInput): Promise<ModuleShellCommandResult>;
}

/** Project-bound GitHub API access. The client resolves its credential per call. */
export interface GitHubApiRequest {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body?: Readonly<Record<string, unknown>>;
}

export interface GitHubApiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface GitHubApi {
  request(input: GitHubApiRequest): Promise<GitHubApiResponse>;
  get(path: string): Promise<GitHubApiResponse>;
}

/** Provider-neutral Work Item details exposed through a project-bound adapter. */
export interface WorkItem {
  readonly ref: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
}

/** Provider identity resolved from one Project repository binding. */
export interface ProjectRepositoryIdentity {
  readonly repositoryId: string;
  readonly provider: string;
  readonly owner: string;
  readonly name: string;
}

export interface WorkItemsCapability {
  read(ref: string, repositoryId?: string): Promise<WorkItem>;
  assessReadiness?(input: {
    readonly ref: string;
    readonly repositoryId: string;
    readonly tag: string;
  }): Promise<WorkItemReadinessAssessment>;
}

export interface WorkItemReadinessAssessment {
  readonly status: "ready" | "blocked" | "impossible";
  readonly reason: string;
  readonly blockerRefs: readonly string[];
}

/** A handler may defer durable admission without spending a Delivery retry. */
export class ModuleDeliveryDeferredError extends Error {
  public constructor(
    public readonly status:
      "waiting-capacity" | "blocked" | "impossible" | "ineligible" | "suspended",
    public readonly reason: string,
  ) {
    super(reason);
    this.name = "ModuleDeliveryDeferredError";
  }
}

export interface ExternalMappingRecord {
  readonly status: "attempted" | "completed";
  readonly resourceRef?: string;
}

export interface ExternalMappingCapability {
  readonly recordAttempt: (idempotencyKey: string) => void;
  readonly recordResource: (input: {
    readonly idempotencyKey: string;
    readonly resourceRef: string;
  }) => void;
  readonly read: (idempotencyKey: string) => ExternalMappingRecord | undefined;
  /** Engine-only terminal hook for async handlers. */
  readonly flushPending?: () => void;
}

export interface PollCursorRecord {
  readonly externalEventId: string;
  readonly eventTimestamp: string;
  readonly updatedAt: string;
}

export interface PollCursorCapability {
  readonly read: (repositoryId: string) => PollCursorRecord | undefined;
  readonly write: (input: {
    readonly repositoryId: string;
    readonly externalEventId: string;
    readonly eventTimestamp: string;
  }) => void;
}

export type WorkItemReadinessStatus = "ready" | "blocked" | "impossible";

/** Durable current readiness and one-time admission for a GitHub work item. */
export interface WorkItemReadinessCapability {
  readonly observe: (input: {
    readonly repositoryId: string;
    readonly workItemRef: string;
    readonly status: WorkItemReadinessStatus;
    readonly reason: string;
    readonly blockerRefs: readonly string[];
    readonly observedAt: string;
  }) => boolean;
}

/** Capabilities resolved for one Project and Module Instance only. */
export interface ModuleHandlerCapabilities {
  readonly agentRuntime?: AgentRuntime;
  /** Re-resolves the Project grant immediately before an Agent Runtime starts. */
  readonly revalidateAgentRuntime?: () => AgentRuntimeGrant | undefined;
  readonly externalMappings?: ExternalMappingCapability;
  readonly pollCursor?: PollCursorCapability;
  readonly workItemReadiness?: WorkItemReadinessCapability;
  readonly githubApi?: GitHubApi;
  readonly workItems?: WorkItemsCapability;
  readonly projectBindings?: AgentProjectBindings;
  readonly projectCommands?: ProjectCommandsCapability;
  readonly shell?: ModuleShell;
  readonly workspace?: ModuleWorkspace;
}

export interface AgentRuntimeGrant {
  readonly runtime: AgentRuntime;
  readonly projectBindings: AgentProjectBindings;
}

export type ModuleCapabilityLookup = (
  projectId: string,
  moduleInstanceId: string,
  moduleId: string,
) => ModuleHandlerCapabilities;

export interface ModuleWorkspaceAllocation {
  readonly path: string;
  readonly workingBranch: string;
  readonly baseRevisionSha: string;
}

export interface ModuleWorkspace {
  allocate(input: {
    readonly executionId: string;
    readonly repositoryId: string;
    readonly baseRevision: string;
    readonly branchContext: {
      readonly workItemId: string;
      readonly slug: string;
    };
  }): Promise<ModuleWorkspaceAllocation>;
  release(input: {
    readonly executionId: string;
    readonly outcome: "success" | "failure" | "cancelled";
  }): Promise<void>;
}

export type ModuleExecutionCheckpoint =
  | {
      readonly type: "preparation.started";
      readonly sequence: number;
      readonly timestamp: string;
    }
  | {
      readonly type: "preparation.completed";
      readonly sequence: number;
      readonly timestamp: string;
    }
  | {
      readonly type: "preparation.failed";
      readonly sequence: number;
      readonly timestamp: string;
      readonly output: string;
    }
  | {
      readonly type: "agent.started";
      readonly sequence: number;
      readonly timestamp: string;
    }
  | {
      readonly type: "agent.message";
      readonly sequence: number;
      readonly timestamp: string;
      readonly message: string;
    }
  | {
      readonly type: "validation.started";
      readonly sequence: number;
      readonly timestamp: string;
      readonly check: string;
    }
  | {
      readonly type: "validation.failed";
      readonly sequence: number;
      readonly timestamp: string;
      readonly check: string;
      readonly output: string;
    }
  | {
      readonly type: "commit.created";
      readonly sequence: number;
      readonly timestamp: string;
      readonly branch: string;
      readonly sha: string;
    }
  | {
      readonly type: "branch.pushed";
      readonly sequence: number;
      readonly timestamp: string;
      readonly branch: string;
      readonly sha: string;
    };

export interface ModuleHandlerPublishInput {
  readonly type: string;
  readonly version: number;
  readonly kind: "request" | "fact";
  readonly subject: EventEnvelopeSubject;
  readonly repositoryId?: string;
  readonly target?: EventEnvelopeTarget;
  readonly idempotencyKey?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly metadata?: EventEnvelopeMetadata;
}

export interface ModuleHandlerContext {
  readonly projectId: string;
  readonly executionId: string;
  readonly moduleInstanceId: string;
  readonly repositoryId: string | undefined;
  /** Provider identity resolved for `repositoryId` inside the Project. */
  readonly repository?: ProjectRepositoryIdentity;
  readonly repositoryDefaultBranch: string | undefined;
  readonly event: EventEnvelope;
  readonly configuration: ModuleConfiguration;
  readonly signal: AbortSignal;
  readonly capabilities: ModuleHandlerCapabilities;
  readonly recordCheckpoint: (checkpoint: ModuleExecutionCheckpoint) => void;
  /** Reads durable progress for recovery without exposing another module's state. */
  readonly hasCheckpoint?: (type: ModuleExecutionCheckpoint["type"]) => boolean;
  /** Continues source checkpoint numbering after a reclaimed delivery. */
  readonly lastCheckpointSequence?: () => number;
  readonly publish: (input: ModuleHandlerPublishInput) => EventEnvelope;
  /** Buffers a fact for the terminal failure transaction instead of success. */
  readonly publishFailure: (input: ModuleHandlerPublishInput) => EventEnvelope;
}

export type ModuleHandler = (context: ModuleHandlerContext) => unknown;

export type ModuleHandlerLookup = (moduleId: string) => ModuleHandler | undefined;

export type ModuleConfigurationLookup = (
  projectId: string,
  moduleInstanceId: string,
) => ModuleConfiguration | undefined;

export type ModuleRepositoryDefaultBranchLookup = (
  projectId: string,
  repositoryId: string | undefined,
) => string | undefined;
