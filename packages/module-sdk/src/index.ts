import type {
  EventEnvelope,
  EventEnvelopeMetadata,
  EventEnvelopeSubject,
  EventEnvelopeTarget,
} from "../../eventing/src/envelope.js";
import type { AgentRuntime } from "../../agent-runtime/src/index.js";

export type ModuleConfiguration = Readonly<Record<string, unknown>>;

/** Capabilities resolved for one Project and Module Instance only. */
export interface ModuleHandlerCapabilities {
  readonly agentRuntime?: AgentRuntime;
}

export type ModuleCapabilityLookup = (
  projectId: string,
  moduleInstanceId: string,
  moduleId: string,
) => ModuleHandlerCapabilities;

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
  readonly moduleInstanceId: string;
  readonly repositoryId: string | undefined;
  readonly repositoryDefaultBranch: string | undefined;
  readonly event: EventEnvelope;
  readonly configuration: ModuleConfiguration;
  readonly signal: AbortSignal;
  readonly capabilities: ModuleHandlerCapabilities;
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
