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
}

export interface GitHubApi {
  request(input: GitHubApiRequest): Promise<GitHubApiResponse>;
  get(path: string): Promise<GitHubApiResponse>;
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

/** Capabilities resolved for one Project and Module Instance only. */
export interface ModuleHandlerCapabilities {
  readonly agentRuntime?: AgentRuntime;
  readonly externalMappings?: ExternalMappingCapability;
  readonly githubApi?: GitHubApi;
  readonly projectBindings?: AgentProjectBindings;
  readonly projectCommands?: ProjectCommandsCapability;
  readonly shell?: ModuleShell;
  readonly workspace?: ModuleWorkspace;
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
  readonly repositoryDefaultBranch: string | undefined;
  readonly event: EventEnvelope;
  readonly configuration: ModuleConfiguration;
  readonly signal: AbortSignal;
  readonly capabilities: ModuleHandlerCapabilities;
  readonly recordCheckpoint: (checkpoint: ModuleExecutionCheckpoint) => void;
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
