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
export type ProjectResourceBindingStatus =
  "bound" | "available" | "missing" | "inaccessible" | "incompatible";

/**
 * A resource explicitly granted to this Project but ineligible for one Slot
 * (missing capability, wrong `kind`, or only a partial capability match),
 * named with the Engine's own reason (ADR 0014). Never populated from a
 * resource this Project has no grant for — see `ProjectResourceGrantPort`.
 */
export interface ProjectIneligibleResource {
  readonly candidate: ProjectResourceCandidate;
  readonly reason: string;
}

/** Engine-owned eligibility and repair guidance for one Portable Configuration Slot. */
export interface ProjectResourceBindingChoice {
  readonly slotId: string;
  readonly requiredCapabilities: readonly string[];
  readonly candidates: readonly ProjectResourceCandidate[];
  readonly status: ProjectResourceBindingStatus;
  readonly impact: string;
  readonly repairAction: string;
  /**
   * Optional (ADR 0014): granted-but-ineligible resources for this Slot,
   * named with the Engine's reason. Omitted, never empty-and-present, when
   * there is none, so a fixture predating this field keeps decoding.
   */
  readonly ineligibleGrantedResources?: readonly ProjectIneligibleResource[];
}

export interface ProjectRuntimeReadiness {
  readonly status:
    | "ready"
    | "absent"
    | "access-denied"
    | "incompatible"
    | "checking"
    | "engine-error"
    | "unchecked";
  readonly checkedAt: string | null;
  readonly detail: string;
}

export interface ProjectAgentRuntimeCandidate {
  readonly ref: string;
  readonly displayName: string;
  readonly provider: string;
  readonly version: string | null;
  readonly capabilities: readonly string[];
  readonly bound: boolean;
  readonly selectable: boolean;
  readonly readiness: ProjectRuntimeReadiness;
}

export interface ProjectAgentRuntimeChoices {
  readonly required: boolean;
  readonly items: readonly ProjectAgentRuntimeCandidate[];
  readonly readiness: ProjectRuntimeReadiness;
}

export interface ProjectResourceChoices {
  readonly agentRuntimes?: ProjectAgentRuntimeChoices;
  /** Deduplicated union of candidates eligible for at least one Slot. */
  readonly items: readonly ProjectResourceCandidate[];
  readonly slots: readonly ProjectResourceBindingChoice[];
}

/** Read-only review assembled by the Engine; no review or graph state is persisted. */
export interface ProjectCompositionReview {
  readonly apiVersion: "jarvis.dev/project-composition-review/v1";
  readonly kind: "ProjectCompositionReview";
  readonly projectId: string;
  readonly readyToValidate: boolean;
  readonly composition: ProjectCompositionChoices;
  readonly validation: ProjectValidationReport;
  readonly resources: ProjectResourceChoices;
}

export interface ProjectResourceCandidateRegistry {
  listProjectResourceCandidates(projectId: unknown): readonly ProjectResourceCandidate[];
  getProjectResourceChoices(projectId: unknown): ProjectResourceChoices;
  previewProjectResourceChoices(
    projectId: unknown,
    proposedConfiguration: unknown,
  ): ProjectResourceChoices;
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
  readonly id: string;
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
  /** Local-only process values for this binding; secrets and auth files are forbidden. */
  readonly environment?: Readonly<Record<string, string>>;
}

export interface ProjectBindings {
  readonly apiVersion: "jarvis.dev/project-bindings/v1";
  readonly kind: "ProjectBindings";
  readonly projectId: string;
  readonly repositories: Readonly<Record<string, ProjectRepositoryBinding>>;
  readonly slots: Readonly<Record<string, ProjectSlotBinding>>;
}

export interface ProjectValidationContract {
  readonly type: string;
  readonly version: number;
  readonly kind: "request" | "fact";
}

export interface ProjectRequestContract extends ProjectValidationContract {
  readonly kind: "request";
}

export interface ProjectValidationInstanceTarget {
  readonly instanceId: string;
  readonly moduleId: string;
}

export interface ProjectRequestRoute {
  readonly contract: ProjectRequestContract;
  readonly producer: ProjectValidationInstanceTarget;
  readonly consumer: ProjectValidationInstanceTarget;
}

export interface ProjectFactContract extends ProjectValidationContract {
  readonly kind: "fact";
}

/** Every configured request attempt with the validator's routing decision. */
export type ProjectRequestAttemptStatus = "resolved" | "orphaned" | "ambiguous";

/**
 * Internal-only: never serialized under the `ProjectValidationReportV1` wire
 * contract, which predates it (embedding it there crashed the generated
 * Swift client's synthesized destructor — a swift-openapi-generator ARC bug,
 * unrelated to this shape). The composition graph projects it directly from
 * the in-process validation report.
 */
export type ProjectRequestAttempt =
  | {
      readonly contract: ProjectRequestContract;
      readonly producer: ProjectValidationInstanceTarget;
      readonly status: "resolved";
      readonly consumer: ProjectValidationInstanceTarget;
    }
  | {
      readonly contract: ProjectRequestContract;
      readonly producer: ProjectValidationInstanceTarget;
      readonly status: "orphaned";
    }
  | {
      readonly contract: ProjectRequestContract;
      readonly producer: ProjectValidationInstanceTarget;
      readonly status: "ambiguous";
      readonly candidates: readonly ProjectValidationInstanceTarget[];
    };

/** A compatible fact producer to consumer delivery. */
export interface ProjectFactDelivery {
  readonly contract: ProjectFactContract;
  readonly producer: ProjectValidationInstanceTarget;
  readonly consumer: ProjectValidationInstanceTarget;
}

export type ProjectSatisfiedCapabilityTarget =
  | { readonly kind: "module-instance"; readonly instanceId: string }
  | { readonly kind: "slot"; readonly slot: string };

export interface ProjectSatisfiedCapability {
  readonly capability: string;
  readonly target: ProjectSatisfiedCapabilityTarget;
  readonly source: {
    readonly kind: ProjectResourceKind | "repository";
    readonly ref: string;
  };
}

export type ProjectValidationFindingTarget =
  | { readonly kind: "project"; readonly field: string }
  | {
      readonly kind: "request-edge";
      readonly contract: ProjectValidationContract;
      readonly producer: ProjectValidationInstanceTarget;
      readonly candidates?: readonly ProjectValidationInstanceTarget[];
    }
  | {
      readonly kind: "contract-edge";
      readonly producer: ProjectValidationInstanceTarget & {
        readonly contract: ProjectValidationContract;
      };
      readonly consumer: ProjectValidationInstanceTarget & {
        readonly contract: ProjectValidationContract;
      };
    }
  | { readonly kind: "module-instance"; readonly instanceId: string; readonly field: string }
  | { readonly kind: "slot"; readonly slot: string }
  | {
      readonly kind: "capability";
      readonly capability: string;
      readonly instanceId: string;
      readonly binding?: string;
    }
  | {
      readonly kind: "capability";
      readonly capability: string;
      readonly slot: string;
    };

export type ProjectValidationFindingCode =
  | "project.composition-incomplete"
  | "project.binding-missing"
  | "project.capability-unresolved"
  | "project.contract-incompatible"
  | "project.instance-config-invalid"
  | "project.module-package-unavailable"
  | "project.request-ambiguous"
  | "project.request-orphaned";

export interface ProjectValidationFinding {
  readonly code: ProjectValidationFindingCode;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly target: ProjectValidationFindingTarget;
  /** A safe, explicit Draft-only repair proposal for the macOS editor. */
  readonly repositoryReferenceReplacement?: {
    readonly field: string;
    readonly from: string;
    readonly to: string;
  };
}

export interface ProjectValidationReport {
  readonly apiVersion: "jarvis.dev/project-validation/v1";
  readonly kind: "ProjectValidationReport";
  readonly projectId: string;
  readonly valid: boolean;
  readonly requestRoutes: readonly ProjectRequestRoute[];
  /**
   * Every configured request attempt with its routing decision, for the
   * composition graph to project. Always populated by this engine; optional
   * only so wire responses can omit it — see `toWireValidationReport` in
   * `apps/engine/src/projects/service.ts`.
   */
  readonly requestAttempts?: readonly ProjectRequestAttempt[];
  /** Compatible fact deliveries (broadcast), for the composition graph to project. Always populated; see `requestAttempts`. */
  readonly factDeliveries?: readonly ProjectFactDelivery[];
  readonly satisfiedCapabilities: readonly ProjectSatisfiedCapability[];
  readonly findings: readonly ProjectValidationFinding[];
  /**
   * Stable digest of exactly the Portable Configuration and Local Bindings
   * this report describes (ticket #53). `activateProject` takes it back and
   * refuses activation when it no longer matches what is saved right now,
   * instead of silently revalidating a stale report. Always populated by this
   * engine; optional on the wire contract only so a client or fixture
   * predating this ticket need not supply it — see `requestAttempts` above
   * for the identical precedent.
   */
  readonly compositionFingerprint?: string;
}

export interface ProjectCompositionChoiceInstance {
  readonly instanceId: string;
  readonly moduleId: string;
}

export interface ProjectCompositionChoiceConsumer extends ProjectCompositionChoiceInstance {
  readonly compatibility: "compatible" | "incompatible";
}

export type ProjectCompositionChoiceRouting =
  | {
      readonly status: "broadcast" | "orphaned" | "ambiguous";
      readonly explanation: string;
    }
  | {
      readonly status: "resolved";
      readonly selectedConsumer: ProjectCompositionChoiceInstance;
      readonly explanation: string;
    };

export interface ProjectCompositionEventChoice {
  readonly label: string;
  readonly type: string;
  readonly version: number;
  readonly kind: "request" | "fact";
  readonly description: string;
  readonly payloadSchema: Readonly<Record<string, unknown>>;
  readonly producers: readonly ProjectCompositionChoiceInstance[];
  readonly consumers: readonly ProjectCompositionChoiceConsumer[];
  readonly routing: ProjectCompositionChoiceRouting;
}

export interface ProjectCompositionStartingPoint {
  readonly id: "github-development" | "custom";
  readonly displayName: string;
  readonly description: string;
  /** Custom keeps the imported draft; templates replace only its composition fields. */
  readonly template?: PortableProjectConfiguration;
}

/** Capability id and manifest binding name together (ticket 48); binding is
 * omitted, never guessed, when the manifest requirement declares none. */
export interface ProjectModuleCatalogCapabilityRequirement {
  readonly id: string;
  readonly binding?: string;
}

export interface ProjectCompositionModulePackage {
  readonly moduleId: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly categories: readonly string[];
  readonly consumes: readonly string[];
  readonly produces: readonly string[];
  readonly requires: readonly ProjectModuleCatalogCapabilityRequirement[];
  readonly provides: readonly string[];
  readonly configurationSchemaRef: string | null;
  readonly configurationSchema: Readonly<Record<string, unknown>> | null;
}

export interface ProjectCompositionModuleInstance {
  readonly instanceId: string;
  readonly moduleId: string;
  readonly enabled: boolean;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly consumes: readonly string[];
  readonly produces: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly compatibility: "compatible" | "incompatible";
  readonly missingResources: readonly string[];
}

export interface ProjectCompositionChoices {
  readonly apiVersion: "jarvis.dev/project-composition-choices/v1";
  readonly kind: "ProjectCompositionChoices";
  readonly projectId: string;
  readonly startingPoints: readonly ProjectCompositionStartingPoint[];
  readonly modulePackages: readonly ProjectCompositionModulePackage[];
  readonly moduleInstances: readonly ProjectCompositionModuleInstance[];
  readonly choices: readonly ProjectCompositionEventChoice[];
}

/** Live repository resolution status exposed on Project Detail. */
export interface BindingStatus {
  readonly [repositoryId: string]: {
    readonly path: string;
    readonly accessible: boolean;
    readonly bookmarkRef: string | null;
  };
}
