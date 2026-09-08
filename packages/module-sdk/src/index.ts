import type {
  EventEnvelope,
  EventEnvelopeMetadata,
  EventEnvelopeSubject,
  EventEnvelopeTarget,
} from "../../eventing/src/envelope.js";
import type { AgentRuntime } from "../../agent-runtime/src/index.js";
import type { AgentProjectBindings } from "../../agent-runtime/src/request-builder.js";

export type ModuleConfiguration = Readonly<Record<string, unknown>>;

/** Capabilities resolved for one Project and Module Instance only. */
export interface ModuleHandlerCapabilities {
  readonly agentRuntime?: AgentRuntime;
  readonly projectBindings?: AgentProjectBindings;
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
