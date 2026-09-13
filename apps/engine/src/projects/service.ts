import type {
  WorkItemReadinessSnapshot,
  WorkItemReadinessStore,
} from "../../../../packages/modules/github/src/work-item-readiness.js";
import {
  preflightGitHub,
  check,
  workflowRule,
  isGitHubDevelopmentFlow,
  type ProjectPreflight,
} from "./preflight.js";
import type { GitHubApi } from "../../../../packages/module-sdk/src/index.js";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  RequestRoutingError,
  resolveConsumers,
  resolveRequestCandidates,
  resolveRequestConsumer,
  type RequestEnvelope,
} from "../../../../packages/eventing/src/routing.js";
import type { ModuleHost } from "../../../../packages/kernel/src/module-host.js";
import {
  projectResourceCandidates,
  type ProjectCompositionValidationPort,
} from "../../../../packages/project-runtime/src/composition-validator.js";
import { previewProjectCompositionChoices } from "../../../../packages/project-runtime/src/composition-choices.js";
import {
  buildProjectCompositionGraph,
  type ProjectCompositionGraphEdge,
} from "../../../../packages/project-runtime/src/composition-graph.js";
import { deriveProjectSubscriptions } from "../../../../packages/project-runtime/src/project-subscriptions.js";
import { EventJournalReader, type ListEventsQuery } from "../events/timeline.js";
import type { DeadLetterReader } from "../events/dead-letters.js";
import {
  ExecutionLedgerReader,
  type ListExecutionsQuery,
  type LedgerExecutionSummary,
} from "../executions/ledger.js";
import type { ExecutionCheckpointStore } from "../executions/checkpoints.js";
import type { WorkspaceLeaseRepository } from "../../../../packages/workspace/src/lease-repository.js";
import { buildExecutionDetail } from "./execution-detail.js";
import type { DevelopmentAdmissions } from "../executions/development-admissions.js";
import type { GitHubPollingStatusStore, GitHubPollingStatus } from "../events/polling-status.js";
import type {
  ActivateProjectRequest,
  ImportProjectRequest,
  ProjectRegistry,
  ReplaceProjectBindingsRequest,
  ReplaceProjectConfigurationRequest,
  RepositoryDiscoveryPort,
  UpdateRepositoryBindingRequest,
} from "../../../../packages/kernel/src/project-registry.js";
import { EngineError } from "../errors.js";
import {
  discoverRepository,
  readRepositoryRemotes,
  publicRemoteUrl,
  RepositoryPathError,
  requireRepositoryDirectory,
  slugify,
} from "./discovery.js";
import {
  requirePortableProjectConfiguration,
  requirePortableProjectDraft,
  requireProjectBindings,
  validatePortableConfig,
} from "./contracts.js";
import type { ProjectConfigurationWriter } from "./repository-config-writer.js";
import type { RepositoryAccessibilityPort } from "./repository-accessibility.js";
import type { ProjectRow, ProjectStore, ResolvedProjectSnapshot } from "./store.js";
import { ProjectRepositoryResolver } from "./repository-resolution.js";
import type {
  BindingStatus,
  ProjectCompositionChoices,
  ProjectCompositionGraph,
  ProjectCompositionReview,
  ProjectGraph,
  PortableProjectConfiguration,
  ProjectBindings,
  ProjectIneligibleResource,
  ProjectResourceCandidate,
  ProjectResourceChoices,
  ProjectResourceGrantPort,
  ProjectValidationReport,
  ProjectDetail,
  ProjectSummary,
  ProjectOverview,
  ProjectExecutionDetail,
  ProjectOverviewIssue,
  ProjectOverviewStage,
  StoredPortableProjectConfiguration,
  RepositoryDiscovery,
  EventSummary,
  ExecutionSummary,
  DeadLetterSummary,
} from "./types.js";
import type { ProjectSubscriptions } from "../../../../packages/project-runtime/src/project-subscriptions.js";
import type { ProjectResourceGrant, ProjectResourceGrantDetailsPort } from "./resource-grants.js";

import {
  checkProjectRuntimeReadiness,
  runtimeSlots,
  checkProjectTools,
  projectAgentRuntimeChoices,
} from "./runtime-readiness.js";
import { detectedRuntimeEnvironment } from "../runtimes/registry.js";
import type { ProjectAgentRuntimeChoices } from "../../../../packages/project-runtime/src/project-types.js";
import type { LocalAgentRuntimeRegistry } from "./resource-grants.js";

const PROJECT_YAML = join(".jarvis", "project.yaml");
const MAX_PROJECT_YAML_BYTES = 512 * 1024;
const INITIAL_STATUS = "draft" as const;

export class RepositoryDiscoveryService implements RepositoryDiscoveryPort<RepositoryDiscovery> {
  discoverRepository(root: unknown): RepositoryDiscovery {
    try {
      const path = requireRepositoryDirectory(root);
      const committed = readCommittedConfig(path);
      const discovery = discoverRepository(path, committed?.repositories[0]?.remote);
      return committed === undefined
        ? discovery
        : {
            ...discovery,
            suggested: {
              ...discovery.suggested,
              metadata: committed.metadata,
              repositories: committed.repositories,
            },
          };
    } catch (error) {
      throw repositoryPathError(error);
    }
  }
}

export class ProjectService implements ProjectRegistry<
  ProjectSummary,
  ProjectDetail,
  ProjectBindings,
  ProjectValidationReport
> {
  constructor(
    private readonly store: ProjectStore,
    private readonly modules: ModuleHost,
    private readonly repositoryWriter: ProjectConfigurationWriter,
    private readonly resourceGrants: ProjectResourceGrantPort,
    private readonly compositionValidator: ProjectCompositionValidationPort,
    private readonly repositoryAccessibility: RepositoryAccessibilityPort,
    private readonly eventJournal: EventJournalReader,
    private readonly executionLedger: ExecutionLedgerReader,
    private readonly deadLetters: DeadLetterReader = { list: () => [] },
    private readonly repositoryResolver: ProjectRepositoryResolver = new ProjectRepositoryResolver(),
    private readonly agentRuntimes?: LocalAgentRuntimeRegistry,
    private readonly preflightApi?: (ref: string) => GitHubApi | undefined,
    private readonly readiness?: Pick<WorkItemReadinessStore, "wasAdmitted"> &
      Partial<Pick<WorkItemReadinessStore, "list">>,
    private readonly developmentAdmissions?: Pick<DevelopmentAdmissions, "read">,
    private readonly pollingStatus?: Pick<GitHubPollingStatusStore, "read">,
    private readonly checkpoints?: Pick<ExecutionCheckpointStore, "listForDetail">,
    private readonly workspaceLeases?: Pick<WorkspaceLeaseRepository, "findByExecution">,
  ) {}

  importProject(request: ImportProjectRequest): ProjectDetail {
    let repositoryPath: string;
    try {
      repositoryPath = requireRepositoryDirectory(request.repositoryPath);
    } catch (error) {
      throw repositoryPathError(error);
    }
    const existing = this.store.findByRepositoryPath(repositoryPath);
    if (existing !== undefined) {
      throw new EngineError(
        "project.already-imported",
        409,
        `This repository is already imported as the project "${existing.id}".`,
        { projectId: existing.id },
      );
    }

    const discovery = discoverRepository(repositoryPath);
    if (!discovery.isGitRepository) {
      throw new EngineError(
        "repository.not-git",
        400,
        `The directory "${repositoryPath}" is not a Git repository.`,
      );
    }
    const resolved = resolvePortableConfig(repositoryPath, request.portableConfig, discovery);
    let portableConfig = resolved.configuration;
    if (request.name !== undefined) {
      if (
        typeof request.name !== "string" ||
        request.name.trim() === "" ||
        [...request.name].length > 120
      ) {
        throw configInvalid("Le nom du projet doit contenir entre 1 et 120 caractères.");
      }
      portableConfig = {
        ...portableConfig,
        metadata: { ...portableConfig.metadata, name: request.name.trim() },
      };
    }
    if (!resolved.isDiscoveredDraft) {
      requirePortableProjectConfiguration(portableConfig, this.modules);
    }
    const id = allocateProjectId(portableConfig, this.store);
    const name = portableConfig.metadata.name || id;
    return toDetail(
      this.store.createProject({
        id,
        name,
        status: INITIAL_STATUS,
        portableConfig,
        repositoryPath,
      }),
      this.repositoryAccessibility,
    );
  }

  listProjects(): ProjectSummary[] {
    return this.store.list().map(toSummary);
  }

  getProject(id: unknown): ProjectDetail {
    return toDetail(this.requireProject(id), this.repositoryAccessibility);
  }

  getProjectOverview(id: unknown): ProjectOverview {
    const project = this.requireProject(id);
    const readiness = this.readiness?.list?.(project.id) ?? [];
    const admission = this.developmentAdmissions?.read(project.id) ?? {
      suspended: false,
      items: [],
    };
    const paused = project.status === "paused" || admission.suspended;
    const fallbackReadinessLabel = project.portableConfig.modules.find(
      (module) => module.moduleId === "jarvis.module.github",
    )?.configuration?.["readyLabel"];
    const activeExecutions = this.executionLedger.listActive(project.id);
    const hasActiveExecution = activeExecutions.length > 0;
    const activeSubjects = this.eventJournal.subjectRefsByEventId(
      project.id,
      activeExecutions.map((execution) => execution.inputEventId),
    );
    const activeRefs = new Set(
      [...activeSubjects.values()].filter((ref): ref is string => typeof ref === "string"),
    );
    const activeExecutionIdsByRef = new Map(
      activeExecutions.flatMap((execution) => {
        const ref = activeSubjects.get(execution.inputEventId);
        return ref === undefined ? [] : [[ref, execution.id] as const];
      }),
    );
    const workRequests = this.eventJournal.latestRequestsBySubject(
      project.id,
      ["development.implementation.requested", "scm.change-request.creation-requested"],
      100,
    );
    const requestRefs = new Map(workRequests.map((event) => [event.id, event.subjectRef]));
    const latestExecutions = this.executionLedger.latestByInputEventIds(
      project.id,
      workRequests.map((event) => event.id),
    );
    const latestByRef = new Map(
      latestExecutions.flatMap((execution) => {
        const ref = requestRefs.get(execution.inputEventId);
        return ref === undefined ? [] : [[ref, execution] as const];
      }),
    );
    const admissionByRef = new Map(
      admission.items.flatMap((item) =>
        item.workItemRef === undefined ? [] : [[item.workItemRef, item] as const],
      ),
    );
    const issues = readiness
      .map((snapshot) =>
        overviewIssue(snapshot, {
          activeRefs,
          activeExecutionIdsByRef,
          latestExecution:
            activeExecutions.find(
              (execution) => execution.id === activeExecutionIdsByRef.get(snapshot.workItemRef),
            ) ?? latestByRef.get(snapshot.workItemRef),
          admission: admissionByRef.get(snapshot.workItemRef),
          paused,
          hasActiveExecution,
          fallbackReadinessLabel:
            typeof fallbackReadinessLabel === "string" && fallbackReadinessLabel.trim() !== ""
              ? fallbackReadinessLabel.trim()
              : "ready-for-agent",
        }),
      )
      .filter((issue): issue is ProjectOverviewIssue => issue !== undefined)
      .sort(
        (left, right) =>
          Number(right.status === "in-progress") - Number(left.status === "in-progress") ||
          (right.executionStartedAt ?? "").localeCompare(left.executionStartedAt ?? "") ||
          Number(right.status === "eligible") - Number(left.status === "eligible"),
      )
      .slice(0, 100);
    const polling = aggregatePolling(paused, this.pollingStatus?.read(project.id) ?? []);
    const lastWorkFailed =
      latestExecutions[0]?.status === "failed" || latestExecutions[0]?.status === "timed-out";
    const overviewStatus = overviewStatusFor(
      project.status,
      activeExecutions.length,
      polling.state,
      lastWorkFailed,
    );
    let selectedWorkItemRef: string | null = null;
    try {
      const ref = workflowRule(project.portableConfig).rule.when.equals?.["payload.workItemRef"];
      if (typeof ref === "string") selectedWorkItemRef = ref;
    } catch {
      /* Custom workflows need not have a guide-compatible rule. */
    }
    const eligible = issues.some((issue) => issue.status === "eligible");
    const stages = overviewStages(polling.state, hasActiveExecution, eligible, project.status);
    return {
      apiVersion: "jarvis.dev/project-overview/v1",
      kind: "ProjectOverview",
      projectId: project.id,
      name: project.name,
      selectedWorkItemRef,
      status: overviewStatus,
      primaryAction:
        overviewStatus === "degraded" && !lastWorkFailed
          ? "refresh"
          : project.status === "paused"
            ? "resume"
            : project.status === "active" || project.status === "degraded"
              ? "pause"
              : "activate",
      polling,
      workflow: {
        available:
          project.status === "active" ||
          project.status === "paused" ||
          project.status === "degraded",
        stages,
        nextStep: nextOverviewStep(
          overviewStatus,
          hasActiveExecution,
          eligible,
          polling.state,
          lastWorkFailed,
        ),
      },
      issues,
      activeExecutionCount: activeExecutions.length,
      activeWorkItemRefs: [...activeRefs].sort(),
      readinessHelp: readinessHelp(project, readiness),
    };
  }

  pauseProject(id: unknown): ProjectSummary {
    const project = this.requireProject(id);
    if (project.status !== "active" && project.status !== "paused") {
      throw new EngineError(
        "project.active",
        409,
        `Project "${project.id}" must be active before it can be paused.`,
      );
    }
    const updated = this.store.setStatus(project.id, "paused");
    if (updated === undefined) throw notFound(project.id);
    return toSummary(updated);
  }

  resumeProject(id: unknown): ProjectSummary {
    const project = this.requireProject(id);
    if (project.status !== "active" && project.status !== "paused") {
      throw new EngineError(
        "project.active",
        409,
        `Project "${project.id}" must be active or paused before it can resume.`,
      );
    }
    const updated = this.store.setStatus(project.id, "active");
    if (updated === undefined) throw notFound(project.id);
    return toSummary(updated);
  }

  private readonly preflights = new Map<string, ProjectPreflight>();
  private readonly preflightRevisions = new Map<string, number>();

  async preflightProject(id: unknown): Promise<ProjectPreflight> {
    const project = this.requireProject(id);
    const revision = (this.preflightRevisions.get(project.id) ?? 0) + 1;
    this.preflightRevisions.set(project.id, revision);
    this.preflights.delete(project.id);
    const { validation, repositoryIdentities } = this.validateComposition(project, undefined);
    const runtime = await this.checkProjectRuntime(project.id);
    const github = await preflightGitHub({
      configuration: project.portableConfig,
      repositories: repositoryIdentities,
      now: Date.now,
      wasAdmitted: (repositoryId, ref) =>
        this.readiness?.wasAdmitted(project.id, repositoryId, ref) ?? false,
      apiFor: (slot) => {
        const binding = project.slotBindings[slot];
        if (
          binding?.kind !== "connection" ||
          !this.resourceGrants
            .grantedToProject(project.id)
            .some((r) => r.kind === "connection" && r.ref === binding.ref)
        )
          return undefined;
        return this.preflightApi?.(binding.ref);
      },
    });
    const checks = [
      ...validation.findings.map((finding, index) =>
        check(
          `composition:${index}`,
          finding.message,
          finding.severity !== "error",
          finding.message,
          finding.target.kind === "slot" || finding.target.kind === "capability"
            ? "Connections"
            : finding.code.startsWith("repository.")
              ? "Repository"
              : "Workflow",
        ),
      ),
      check(
        "composition",
        "Composition et routage exact",
        validation.valid,
        "Chaque Request doit avoir un unique consumer actif et ses ressources requises.",
        "Workflow",
      ),
      check(
        "runtime",
        "Runtime agentique",
        !runtime.required || runtime.readiness.status === "ready",
        runtime.readiness.detail,
        "Connections",
      ),
      ...github.checks,
      ...checkProjectTools(project),
    ];
    if (
      this.preflightRevisions.get(project.id) !== revision ||
      this.validateProject(project.id).compositionFingerprint !== validation.compositionFingerprint
    ) {
      throw activationRejected(
        "project.activation-report-stale",
        project.id,
        "changed during preflight",
      );
    }
    const valid = validation.valid && checks.every((c) => c.status === "passed");
    const report: ProjectPreflight = {
      apiVersion: "jarvis.dev/project-preflight/v1",
      kind: "ProjectPreflight",
      projectId: project.id,
      compositionFingerprint: validation.compositionFingerprint!,
      valid,
      configurationReady: valid,
      validation: toWireValidationReport(validation),
      runtime,
      ...github,
      checks,
    };
    this.preflights.set(project.id, report);
    return report;
  }

  activatePreflightProject(request: ActivateProjectRequest): ProjectSummary {
    const project = this.requireProject(request.projectId);
    const report = this.preflights.get(project.id);
    if (!report?.valid || report.compositionFingerprint !== request.compositionFingerprint)
      throw activationRejected(
        "project.activation-not-validated",
        project.id,
        "requires a current successful preflight",
      );
    return this.activateProject(request);
  }

  scopePreflightProject(id: unknown, request: unknown): PortableProjectConfiguration {
    const project = this.requireProject(id);
    const body = request as
      { compositionFingerprint?: unknown; workItemRef?: unknown; scope?: unknown } | undefined;
    const report = this.preflights.get(project.id);
    if (
      !report ||
      body?.compositionFingerprint !== report.compositionFingerprint ||
      this.validateProject(project.id).compositionFingerprint !== report.compositionFingerprint
    )
      throw activationRejected(
        "project.activation-report-stale",
        project.id,
        "requires a current preflight before changing scope",
      );
    if (body.scope !== "issue" && body.scope !== "all")
      throw new EngineError("api.invalid-request", 400, "Choose issue or all scope explicitly.");
    const ref = body.scope === "all" ? null : body.workItemRef;
    if (body.scope === "all" && Object.hasOwn(body, "workItemRef"))
      throw new EngineError("api.invalid-request", 400, "All scope cannot name a selected issue.");
    if (
      body.scope === "issue" &&
      (typeof ref !== "string" ||
        !report.candidateEligibility.items.some((item) => item.workItemRef === ref))
    )
      throw new EngineError(
        "api.invalid-request",
        400,
        "Select an issue from this project's current preview.",
      );
    const configuration = structuredClone(project.portableConfig) as PortableProjectConfiguration;
    let selected: ReturnType<typeof workflowRule>;
    try {
      selected = workflowRule(configuration);
    } catch {
      throw new EngineError("api.invalid-request", 400, "Repair the workflow rule first.");
    }
    const instance = configuration.modules.find(
      (m) => m.instanceId === selected.instance.instanceId,
    )!;
    const rules = instance.configuration!["rules"] as {
      id: string;
      when: { equals: Record<string, unknown> };
    }[];
    const equals = rules.find((r) => r.id === selected.rule.id)!.when.equals;
    if (ref === null) delete equals["payload.workItemRef"];
    else equals["payload.workItemRef"] = ref;
    return configuration;
  }

  validateProject(id: unknown): ProjectValidationReport {
    const project = this.requireProject(id);
    return toWireValidationReport(this.validateComposition(project, undefined).validation);
  }

  /**
   * Activation guard (ticket #53): the recomputed report's `compositionFingerprint`
   * must match the one the client supplies, proving it describes the composition
   * and Local Bindings saved right now rather than a stale one — never silently
   * revalidated. On success it freezes the immutable Resolved Project and moves
   * the Project to `active`; a rejection leaves durable state untouched, and
   * repeating activation of an unchanged composition is idempotent.
   */
  activateProject(request: ActivateProjectRequest): ProjectSummary {
    const project = this.requireProject(request.projectId);
    const { validation: report, repositoryIdentities } = this.validateComposition(
      project,
      undefined,
    );
    // Optional only on the wire contract, for a fixture predating ticket #53
    // (see `ProjectValidationReport.compositionFingerprint`); this engine's own
    // validator always sets it.
    const currentFingerprint = report.compositionFingerprint;
    if (currentFingerprint === undefined) {
      throw new EngineError(
        "system.internal-error",
        500,
        "The composition validator produced no compositionFingerprint.",
      );
    }

    const supplied = request.compositionFingerprint;
    if (typeof supplied !== "string" || supplied.trim() === "") {
      throw activationRejected(
        "project.activation-not-validated",
        project.id,
        "has no successful validation report for its current composition",
      );
    }
    if (supplied !== currentFingerprint) {
      throw activationRejected(
        "project.activation-report-stale",
        project.id,
        "changed its configuration or Local Bindings since the supplied validation report",
      );
    }
    if (!report.valid) {
      throw activationRejected(
        "project.activation-not-validated",
        project.id,
        "has no successful validation report for its current composition",
      );
    }

    const configuration = project.portableConfig;
    const snapshot: ResolvedProjectSnapshot = {
      composition: configuration,
      moduleInstances: "modules" in configuration ? configuration.modules : [],
      bindings: {
        slots: project.slotBindings,
        repository: { path: project.repositoryPath, bookmarkRef: project.bookmarkRef },
      },
      requestRoutes: report.requestRoutes,
      ...(repositoryIdentities.length === 0 ? {} : { repositoryIdentities }),
    };
    const updated = this.store.activateProject(project.id, currentFingerprint, snapshot);
    if (updated === undefined) throw notFound(project.id);
    return toSummary(updated);
  }

  /**
   * Ticket #54: the open subscription set, derived fresh from the frozen
   * Resolved Project (ticket #53) and the Module Package Manifests — no
   * second durable store, so it can never drift from what was activated.
   * Before activation ever succeeded there is no Resolved Project yet, and
   * the set is empty: no subscription is open before an Event could ever be
   * routed to it.
   */
  listProjectSubscriptions(id: unknown): ProjectSubscriptions {
    const project = this.requireProject(id);
    const resolved = this.store.getResolvedProject(project.id);
    return deriveProjectSubscriptions(project.id, resolved?.moduleInstances ?? [], this.modules);
  }

  /**
   * Ticket #59: the durable Event journal, scoped to this Project and
   * delegated to Eventing's own reader (`EventJournalReader`) rather than
   * queried here — this method's only job is the 404 guard every
   * project-scoped read already does (docs/architecture/PERSISTENCE.md
   * "Logical ownership").
   */
  listProjectEvents(id: unknown, query: ListEventsQuery): { readonly items: EventSummary[] } {
    const project = this.requireProject(id);
    return { items: this.eventJournal.list(project.id, query) };
  }

  /**
   * Ticket #59: the Execution Ledger's rows for this Project, plus each
   * Execution's correlation — looked up through Eventing's own reader from
   * the `inputEventId` the Ledger already carries, never by this method
   * reading `events` itself (docs/architecture/PERSISTENCE.md "Logical
   * ownership"). `query.limit` carries the same bound `listProjectEvents`
   * already enforces (issue #59 code review, finding 1).
   */
  listProjectExecutions(
    id: unknown,
    query: ListExecutionsQuery,
  ): { readonly items: ExecutionSummary[] } {
    const project = this.requireProject(id);
    const executions = this.executionLedger.list(project.id, query);
    const correlationIds = this.eventJournal.correlationIdsByEventId(
      project.id,
      executions.map((execution) => execution.inputEventId),
    );
    return {
      items: executions.map((execution) => {
        const correlationId = correlationIds.get(execution.inputEventId);
        // `exactOptionalPropertyTypes` (tsconfig.json): an always-present
        // `correlationId: undefined` key is not assignable to
        // `ExecutionSummary`'s optional `correlationId?: string`, so it is
        // conditionally spread rather than passed through directly (mirrors
        // executions/delivery-consumer.ts's `buildContext`).
        return { ...execution, ...(correlationId === undefined ? {} : { correlationId }) };
      }),
    };
  }

  getExecutionDetail(id: unknown, executionId: unknown): ProjectExecutionDetail {
    const project = this.requireProject(id);
    if (typeof executionId !== "string" || executionId.trim() === "") {
      throw new EngineError("api.invalid-request", 400, "Execution id is required.");
    }
    const anchor = this.executionLedger.findById(project.id, executionId);
    if (anchor === undefined) throw notFound(executionId);
    const anchorEvent = this.eventJournal.findById(project.id, anchor.inputEventId);
    if (anchorEvent === undefined) throw notFound(executionId);
    const listedEvents = this.eventJournal.listDetails(project.id, {
      correlationId: anchorEvent.correlationId,
      limit: 100,
    });
    const events = listedEvents.some((event) => event.id === anchorEvent.id)
      ? listedEvents
      : [anchorEvent, ...listedEvents.slice(0, 99)].sort((left, right) =>
          `${right.occurredAt}\u0000${right.id}`.localeCompare(
            `${left.occurredAt}\u0000${left.id}`,
          ),
        );
    const executions = this.executionLedger.listByInputEventIds(
      project.id,
      events.map((event) => event.id),
    );
    const uniqueExecutions = [
      ...new Map(
        [anchor, ...executions].map((execution) => [execution.id, execution] as const),
      ).values(),
    ];
    const allExecutions =
      uniqueExecutions.length <= 100
        ? uniqueExecutions
        : [anchor, ...uniqueExecutions.filter(({ id }) => id !== anchor.id).slice(-99)];
    const checkpoints = new Map(
      allExecutions.map(
        (execution) =>
          [execution.id, this.checkpoints?.listForDetail(project.id, execution.id) ?? []] as const,
      ),
    );
    const leases = new Map(
      allExecutions.map(
        (execution) =>
          [execution.id, this.workspaceLeases?.findByExecution(project.id, execution.id)] as const,
      ),
    );
    const executionIds = new Set(allExecutions.map((execution) => execution.id));
    const retryDeliveryId =
      this.deadLetters
        .list(project.id)
        .find(
          (deadLetter) =>
            deadLetter.lastExecutionId !== null && executionIds.has(deadLetter.lastExecutionId),
        )?.deliveryId ?? null;
    const correlationId = anchorEvent.correlationId;
    const correlationIds = this.eventJournal.correlationIdsByEventId(
      project.id,
      allExecutions.map((execution) => execution.inputEventId),
    );
    return buildExecutionDetail({
      projectId: project.id,
      correlationId,
      anchor,
      executions: allExecutions.map((execution) => ({
        ...execution,
        ...(correlationIds.get(execution.inputEventId) === undefined
          ? {}
          : { correlationId: correlationIds.get(execution.inputEventId) }),
      })),
      events,
      checkpoints,
      leases,
      readiness: this.readiness?.list?.(project.id) ?? [],
      retryDeliveryId,
    });
  }

  listProjectDeadLetters(id: unknown): { readonly items: DeadLetterSummary[] } {
    const project = this.requireProject(id);
    return { items: this.deadLetters.list(project.id) };
  }

  previewCompositionChoices(
    id: unknown,
    proposedConfiguration: unknown,
  ): ProjectCompositionChoices {
    return this.compositionReview(id, proposedConfiguration).composition;
  }

  compositionReview(id: unknown, proposedConfiguration: unknown): ProjectCompositionReview {
    const project = this.requireProject(id);
    const { configuration, validation, repositoryIdentities } = this.validateComposition(
      project,
      proposedConfiguration,
    );
    const grantedResources = resourceGrantDetails(this.resourceGrants, project.id);
    const composition = previewProjectCompositionChoices(this.modules, {
      projectId: project.id,
      configuration,
      slotBindings: project.slotBindings,
      validationFindings: validation.findings,
      repositoryMappings: configuration.repositories.map((repository) => {
        const identity = repositoryIdentities.find((item) => item.repositoryId === repository.id);
        const provider =
          identity === undefined
            ? "GitHub identity unresolved"
            : `GitHub ${identity.owner}/${identity.name}`;
        return `Repository ${repository.id} → ${provider}; identity remote ${repository.remote ?? "origin"}; push remote ${configuration.git.pushRemote}; target branch ${repository.defaultBranch ?? "main"}.`;
      }),
    });
    return {
      apiVersion: "jarvis.dev/project-composition-review/v1",
      kind: "ProjectCompositionReview",
      projectId: project.id,
      readyToValidate: validation.valid,
      githubDevelopmentFlow: isGitHubDevelopmentFlow(configuration, validation),
      composition,
      validation: toWireValidationReport(validation),
      resources: resourceChoices(
        project,
        configuration,
        this.modules,
        grantedResources,
        this.agentRuntimes,
      ),
    };
  }

  /**
   * Composition graph read model: the derived, read-only projection the Wizard
   * and Project Overview consume. Same dual shape as the review: the saved
   * composition, or a proposed configuration evaluated against the current
   * Local Bindings. Mutates nothing.
   */
  compositionGraph(id: unknown, proposedConfiguration: unknown): ProjectCompositionGraph {
    const project = this.requireProject(id);
    const { configuration, validation } = this.validateComposition(project, proposedConfiguration);
    return buildProjectCompositionGraph(this.modules, {
      configuration,
      slotBindings: project.slotBindings,
      validation,
    });
  }

  /** The emergent graph is derived fresh from the immutable Resolved Project. */
  getProjectGraph(id: unknown): ProjectGraph {
    const project = this.requireProject(id);
    const resolved = this.store.getResolvedProject(project.id);
    const nodes = (resolved?.moduleInstances ?? [])
      .filter((instance) => instance.enabled)
      .map((instance) => {
        const packageEntry = this.modules.package(instance.moduleId);
        return {
          instanceId: instance.instanceId,
          moduleId: instance.moduleId,
          enabled: instance.enabled,
          moduleVersion: packageEntry?.version ?? null,
          displayName: packageEntry?.displayName ?? null,
          findings: [],
        };
      })
      .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
    if (resolved === undefined) return { nodes, edges: [], valid: true, issues: [] };
    const subscriptions = deriveProjectSubscriptions(
      project.id,
      resolved.moduleInstances,
      this.modules,
    );
    const issues: Omit<ProjectGraph["issues"][number], "id">[] = [];
    const requestEdges: ProjectCompositionGraphEdge[] = resolved.moduleInstances
      .filter((instance) => instance.enabled)
      .flatMap((producer) =>
        (this.modules.composition(producer.moduleId)?.produces ?? [])
          .filter((contract) => contract.kind === "request")
          .flatMap((contract): ProjectCompositionGraphEdge[] => {
            const configuredTargets = this.modules.configuredRequestTargets(
              producer.moduleId,
              producer.configuration,
              contract,
              producer.instanceId,
            );
            const targets = configuredTargets ?? [undefined];
            return targets.map((target) => {
              const from = { instanceId: producer.instanceId, moduleId: producer.moduleId };
              const graphContract = {
                type: contract.type,
                version: contract.version,
                kind: "request" as const,
              };
              const request: RequestEnvelope = {
                projectId: project.id,
                type: contract.type,
                version: contract.version,
                kind: "request",
                producer: {
                  moduleId: producer.moduleId,
                  moduleInstanceId: producer.instanceId,
                },
                ...(target === undefined ? {} : { target }),
              };
              let candidates: readonly {
                moduleInstanceId: string;
                moduleId: string;
              }[];
              if (target === undefined) {
                candidates = resolveRequestCandidates(request, resolved);
              } else {
                try {
                  candidates = [resolveRequestConsumer(request, resolved)];
                } catch (error) {
                  if (
                    error instanceof RequestRoutingError &&
                    (error.code === "request-consumer-not-found" ||
                      error.code === "request-consumer-ambiguous")
                  ) {
                    candidates = error.candidates;
                  } else {
                    throw error;
                  }
                }
              }
              if (candidates.length === 1) {
                const consumer = {
                  instanceId: candidates[0]!.moduleInstanceId,
                  moduleId: candidates[0]!.moduleId,
                };
                return {
                  kind: "request" as const,
                  contract: graphContract,
                  from,
                  to: consumer,
                  routing: { status: "resolved" as const, consumer },
                  findings: [],
                };
              }

              const ambiguous = candidates.length > 1;
              const code = ambiguous
                ? ("project.request-ambiguous" as const)
                : ("project.request-orphaned" as const);
              issues.push({
                code,
                severity: "error",
                message: ambiguous
                  ? `Request ${contract.type}.v${contract.version} from ${producer.instanceId} has multiple consumers.`
                  : `Request ${contract.type}.v${contract.version} from ${producer.instanceId} has no consumer.`,
                target: {
                  kind: "request-edge",
                  contract: graphContract,
                  producer: from,
                  ...(ambiguous
                    ? {
                        candidates: candidates.map((candidate) => ({
                          instanceId: candidate.moduleInstanceId,
                          moduleId: candidate.moduleId,
                        })),
                      }
                    : {}),
                },
              });
              return {
                kind: "request" as const,
                contract: graphContract,
                from,
                routing: ambiguous
                  ? {
                      status: "ambiguous" as const,
                      candidates: candidates.map((candidate) => ({
                        instanceId: candidate.moduleInstanceId,
                        moduleId: candidate.moduleId,
                      })),
                    }
                  : { status: "orphaned" as const },
                findings: [code],
              };
            });
          }),
      );
    const factEdges: ProjectCompositionGraphEdge[] = resolved.moduleInstances
      .filter((instance) => instance.enabled)
      .flatMap((producer) =>
        (this.modules.composition(producer.moduleId)?.produces ?? [])
          .filter((contract) => contract.kind === "fact")
          .flatMap((contract): ProjectCompositionGraphEdge[] => {
            const consumers = resolveConsumers(
              { type: contract.type, version: contract.version, kind: "fact" },
              subscriptions.items,
            );
            const from = { instanceId: producer.instanceId, moduleId: producer.moduleId };
            const graphContract = {
              type: contract.type,
              version: contract.version,
              kind: "fact" as const,
            };
            if (consumers.length === 0) {
              return [{ kind: "fact" as const, contract: graphContract, from, findings: [] }];
            }
            return consumers.map((consumer) => ({
              kind: "fact" as const,
              contract: graphContract,
              from,
              to: { instanceId: consumer.moduleInstanceId, moduleId: consumer.moduleId },
              findings: [],
            }));
          }),
      );
    const edges = [
      ...new Map(
        [...requestEdges, ...factEdges].map((edge) => [JSON.stringify(edge), edge]),
      ).values(),
    ].sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.contract.type.localeCompare(right.contract.type) ||
        left.contract.version - right.contract.version ||
        left.from.instanceId.localeCompare(right.from.instanceId) ||
        (left.to?.instanceId ?? "").localeCompare(right.to?.instanceId ?? ""),
    );
    const graphIssues = [...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values()]
      .sort(
        (left, right) =>
          left.target.kind.localeCompare(right.target.kind) ||
          (left.target.kind === "request-edge" && right.target.kind === "request-edge"
            ? left.target.contract.type.localeCompare(right.target.contract.type) ||
              left.target.contract.version - right.target.contract.version ||
              left.target.producer.instanceId.localeCompare(right.target.producer.instanceId)
            : 0),
      )
      .map((issue, index) => ({ ...issue, id: `f${index + 1}` }));

    return {
      nodes,
      edges,
      valid: requestEdges.every((edge) => edge.routing?.status === "resolved"),
      issues: graphIssues,
    };
  }

  /**
   * Resolves the saved or proposed configuration and runs the shared
   * composition validator once, against the project's current Local Bindings.
   */
  private validateComposition(
    project: ProjectRow,
    proposedConfiguration: unknown,
  ): {
    readonly configuration: StoredPortableProjectConfiguration;
    readonly validation: ProjectValidationReport;
    readonly repositoryIdentities: NonNullable<ResolvedProjectSnapshot["repositoryIdentities"]>;
  } {
    const configuration =
      proposedConfiguration === undefined
        ? project.portableConfig
        : requirePortableProjectConfiguration(proposedConfiguration, this.modules);
    const validation = this.compositionValidator.validate({
      projectId: project.id,
      configuration,
      slotBindings: project.slotBindings,
      repositoryBinding: {
        saved: project.bookmarkRef !== null,
        accessible: this.repositoryAccessibility.isAccessibleDirectory(project.repositoryPath),
        path: project.repositoryPath,
        bookmarkRef: project.bookmarkRef,
      },
      grantedResources: this.resourceGrants.grantedToProject(project.id),
    });
    const repositoryResolution = this.repositoryResolver.validate(
      configuration,
      project.repositoryPath,
    );
    const migrationFinding =
      project.status === "active"
        ? this.repositoryResolver.migrationFinding(
            configuration,
            this.store.getResolvedProject(project.id),
          )
        : undefined;
    const findings = [
      ...validation.findings,
      ...repositoryResolution.findings,
      ...(migrationFinding === undefined ? [] : [migrationFinding]),
    ].sort(
      (left, right) =>
        left.code.localeCompare(right.code) ||
        JSON.stringify(left.target).localeCompare(JSON.stringify(right.target)) ||
        left.severity.localeCompare(right.severity) ||
        left.message.localeCompare(right.message),
    );
    return {
      configuration,
      validation: {
        ...validation,
        valid: findings.every((finding) => finding.severity !== "error"),
        findings,
      },
      repositoryIdentities: repositoryResolution.repositoryIdentities,
    };
  }

  deleteProject(id: unknown): void {
    const projectId = typeof id === "string" ? id : "";
    this.store.transaction(() => {
      const project = this.store.findById(projectId);
      if (project === undefined) throw notFound(projectId || "(empty)");
      if (project.status === "active") {
        throw new EngineError(
          "project.active",
          409,
          `Project "${projectId}" is active and cannot be deleted. Pause it before deleting it.`,
        );
      }
      if (!this.store.deleteById(projectId)) throw notFound(projectId || "(empty)");
    });
  }

  replaceProjectConfiguration(request: ReplaceProjectConfigurationRequest): ProjectDetail {
    const current = this.requireProject(request.projectId);
    if (typeof request.writeToRepository !== "boolean") {
      throw new EngineError("api.invalid-request", 400, "writeToRepository must be a boolean.");
    }
    const supplied = request.portableConfig as Partial<StoredPortableProjectConfiguration>;
    const configuration =
      Array.isArray(supplied.modules) &&
      supplied.modules.length === 0 &&
      typeof supplied.slots === "object" &&
      supplied.slots !== null &&
      Object.keys(supplied.slots).length === 0
        ? requirePortableProjectDraft(request.portableConfig)
        : requirePortableProjectConfiguration(request.portableConfig, this.modules);
    for (const slot of Object.keys(current.slotBindings)) {
      if (!(slot in configuration.slots)) {
        throw new EngineError(
          "project.config-invalid",
          400,
          `/slots/${slot} cannot be removed while a Local Binding still references it.`,
        );
      }
    }
    validateSlotBindings(
      configuration,
      current.slotBindings,
      eligibleCandidates(current.id, configuration, this.modules, this.resourceGrants),
      this.modules,
      "project.config-invalid",
    );

    // Filesystem + SQLite cannot share a transaction. The repository write happens
    // first, then is compensated if SQLite refuses the replacement.
    const compensation = request.writeToRepository
      ? this.repositoryWriter.write(current.repositoryPath, configuration)
      : undefined;
    try {
      const updated = this.store.transaction(() =>
        this.store.replaceConfiguration(current.id, configuration, configuration.metadata.name),
      );
      if (updated === undefined) throw notFound(current.id);
      return toDetail(updated, this.repositoryAccessibility);
    } catch (error) {
      try {
        compensation?.restore();
      } catch {
        throw new EngineError(
          "project.repository-compensation-failed",
          500,
          "SQLite rejected the configuration and the previous repository file could not be restored. Reload the Project and inspect .jarvis/project.yaml before retrying.",
        );
      }
      throw error;
    }
  }

  getProjectBindings(projectId: unknown): ProjectBindings {
    return toBindings(this.requireProject(projectId));
  }

  listProjectResourceCandidates(projectId: unknown): readonly ProjectResourceCandidate[] {
    return this.getProjectResourceChoices(projectId).items;
  }

  getProjectResourceChoices(projectId: unknown): ProjectResourceChoices {
    const current = this.requireProject(projectId);
    return resourceChoices(
      current,
      current.portableConfig,
      this.modules,
      resourceGrantDetails(this.resourceGrants, current.id),
      this.agentRuntimes,
    );
  }

  previewProjectResourceChoices(
    projectId: unknown,
    proposedConfiguration: unknown,
  ): ProjectResourceChoices {
    const current = this.requireProject(projectId);
    const configuration = requirePortableProjectConfiguration(proposedConfiguration, this.modules);
    return resourceChoices(
      current,
      configuration,
      this.modules,
      resourceGrantDetails(this.resourceGrants, current.id),
      this.agentRuntimes,
    );
  }

  bindProjectRuntime(projectId: unknown, request: unknown): ProjectAgentRuntimeChoices {
    const current = this.requireProject(projectId);
    const body = request as { ref?: unknown; approveEnvironment?: unknown } | undefined;
    if (
      body?.approveEnvironment !== true ||
      typeof body.ref !== "string" ||
      Object.keys(body).some((key) => key !== "ref" && key !== "approveEnvironment")
    ) {
      throw new EngineError(
        "api.invalid-request",
        400,
        "Choose a runtime and explicitly approve its local environment profile.",
      );
    }
    const choices = this.getProjectResourceChoices(current.id);
    const candidate = choices.agentRuntimes?.items.find(
      (item) => item.ref === body.ref && item.selectable,
    );
    if (candidate === undefined) {
      throw new EngineError(
        "project.bindings-invalid",
        400,
        "This runtime is not eligible. Refresh discovery and choose a compatible runtime.",
      );
    }
    const slots = { ...current.slotBindings };
    for (const slot of runtimeSlots(current.portableConfig, choices.slots)) {
      slots[slot.slotId] = {
        kind: "runtime",
        ref: candidate.ref,
        environment: detectedRuntimeEnvironment(),
      };
    }
    this.replaceProjectBindings({
      projectId: current.id,
      bindings: { ...this.getProjectBindings(current.id), slots },
    });
    return this.getProjectResourceChoices(current.id).agentRuntimes!;
  }

  async checkProjectRuntime(projectId: unknown): Promise<ProjectAgentRuntimeChoices> {
    const current = this.requireProject(projectId);
    const choices = this.getProjectResourceChoices(current.id);
    if (choices.agentRuntimes === undefined || this.agentRuntimes === undefined) {
      throw new EngineError(
        "system.internal-error",
        503,
        "Runtime verification is unavailable. Retry when the Engine is ready.",
      );
    }
    const snapshot = JSON.stringify([
      current.portableConfig,
      current.slotBindings,
      this.agentRuntimes.descriptors(),
    ]);
    const readiness = await checkProjectRuntimeReadiness(
      current,
      choices.slots,
      this.agentRuntimes,
    );
    const latest = this.requireProject(projectId);
    if (
      snapshot !==
      JSON.stringify([latest.portableConfig, latest.slotBindings, this.agentRuntimes.descriptors()])
    ) {
      return {
        ...this.getProjectResourceChoices(current.id).agentRuntimes!,
        readiness: {
          status: "unchecked",
          checkedAt: null,
          detail: "Le projet a changé pendant la vérification. Vérifiez à nouveau le runtime.",
        },
      };
    }
    return { ...choices.agentRuntimes, readiness };
  }

  replaceProjectBindings(request: ReplaceProjectBindingsRequest): ProjectBindings {
    const current = this.requireProject(request.projectId);
    const bindings = requireProjectBindings(request.bindings);
    if (bindings.projectId !== current.id) {
      throw new EngineError(
        "project.bindings-invalid",
        400,
        "/projectId must match the Project selected by the URL.",
      );
    }
    validateBindingReferences(
      current,
      bindings,
      eligibleCandidates(current.id, current.portableConfig, this.modules, this.resourceGrants),
      this.modules,
    );
    const repositoryIds = current.portableConfig.repositories.map((repository) => repository.id);
    const suppliedIds = Object.keys(bindings.repositories);
    const complete =
      suppliedIds.length === repositoryIds.length &&
      repositoryIds.every((repositoryId) => {
        const supplied = bindings.repositories[repositoryId];
        return (
          supplied !== undefined &&
          supplied.path === current.repositoryPath &&
          supplied.bookmarkRef === current.bookmarkRef
        );
      });
    if (!complete || suppliedIds.some((repositoryId) => !repositoryIds.includes(repositoryId))) {
      throw new EngineError(
        "project.bindings-invalid",
        400,
        "/repositories must contain exactly the declared repositories and preserve their Local Bindings.",
      );
    }

    // Generic Local Bindings replacement cannot establish or replace the shell-owned
    // Repository Grant. Only the dedicated repository binding operation may do that.

    const updated = this.store.transaction(() =>
      this.store.replaceBindings(
        current.id,
        current.repositoryPath,
        current.bookmarkRef,
        bindings.slots,
      ),
    );
    if (updated === undefined) throw notFound(current.id);
    return toBindings(updated);
  }

  updateRepositoryBinding(request: UpdateRepositoryBindingRequest): ProjectDetail {
    const { projectId, repositoryId, path, bookmarkRef } = request;
    const current = this.requireProject(projectId);
    if (!current.portableConfig.repositories.some((repository) => repository.id === repositoryId)) {
      throw new EngineError(
        "api.invalid-request",
        400,
        `Project "${current.id}" has no repository binding "${String(repositoryId)}".`,
      );
    }
    if (typeof bookmarkRef !== "string" || bookmarkRef.trim() === "" || bookmarkRef.length > 300) {
      throw new EngineError(
        "api.invalid-request",
        400,
        "bookmarkRef must be a non-empty local reference of at most 300 characters.",
      );
    }
    let repositoryPath: string;
    try {
      repositoryPath = requireRepositoryDirectory(path);
    } catch (error) {
      throw repositoryPathError(error);
    }
    const updated = this.store.updateRepositoryBinding(current.id, repositoryPath, bookmarkRef);
    if (updated === undefined) throw notFound(current.id);
    return toDetail(updated, this.repositoryAccessibility);
  }

  private requireProject(id: unknown): ProjectRow {
    const projectId = typeof id === "string" ? id : "";
    const row = this.store.findById(projectId);
    if (row === undefined) throw notFound(projectId || "(empty)");
    return row;
  }
}

type OverviewAdmission = ReturnType<DevelopmentAdmissions["read"]>["items"][number];

function overviewIssue(
  snapshot: WorkItemReadinessSnapshot,
  input: {
    readonly activeRefs: ReadonlySet<string>;
    readonly activeExecutionIdsByRef: ReadonlyMap<string, string>;
    readonly latestExecution: LedgerExecutionSummary | undefined;
    readonly admission: OverviewAdmission | undefined;
    readonly paused: boolean;
    readonly hasActiveExecution: boolean;
    readonly fallbackReadinessLabel: string;
  },
): ProjectOverviewIssue | undefined {
  const issueNumber =
    snapshot.issueNumber ?? Number(/\/issues\/(\d+)$/.exec(snapshot.workItemRef)?.[1] ?? NaN);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) return undefined;
  const blockerRefs = [...snapshot.blockerRefs];
  const base = {
    workItemRef: snapshot.workItemRef,
    title: snapshot.title?.trim() || `Issue #${issueNumber}`,
    issueNumber,
    repositoryId: snapshot.repositoryId,
    openDependencyCount: blockerRefs.length,
    blockerRefs,
    readinessLabel: snapshot.tag?.trim() || input.fallbackReadinessLabel,
    executionId:
      input.activeExecutionIdsByRef.get(snapshot.workItemRef) ?? input.latestExecution?.id ?? null,
    lastExecutionStatus: input.latestExecution?.status ?? null,
    executionStartedAt: input.latestExecution?.createdAt ?? null,
    executionCompletedAt: input.latestExecution?.completedAt ?? null,
  };

  if (input.activeRefs.has(snapshot.workItemRef)) {
    return {
      ...base,
      status: "in-progress",
      reason: "execution-active",
      explanation: "An execution is already active for this issue.",
    };
  }
  if (input.latestExecution?.status === "failed" || input.latestExecution?.status === "timed-out") {
    return {
      ...base,
      status: "unavailable",
      reason: "execution-failed",
      explanation:
        "La dernière exécution a échoué. Ouvrez son résultat pour consulter la cause et le travail conservé.",
    };
  }
  if (input.latestExecution?.status === "cancelled") {
    return {
      ...base,
      status: "ineligible",
      reason: "execution-cancelled",
      explanation:
        "L’exécution a été annulée. Son résultat et le travail conservé restent consultables.",
    };
  }
  if (snapshot.admittedAt !== null && input.admission === undefined) {
    return {
      ...base,
      status: "ineligible",
      reason: "already-admitted",
      explanation: "This issue has already been admitted and will not start twice.",
    };
  }

  const admission = input.admission;
  if (admission !== undefined) {
    if (admission.status === "waiting-capacity" || admission.status === "suspended") {
      const executionActive =
        admission.status === "waiting-capacity" && input.hasActiveExecution && !input.paused;
      return {
        ...base,
        status: "waiting",
        reason:
          admission.status === "suspended" || input.paused
            ? "project-paused"
            : executionActive
              ? "execution-active"
              : admission.reason,
        explanation:
          admission.status === "suspended" || input.paused
            ? "New work is paused. Active work continues to be monitored."
            : executionActive
              ? "An execution is already active for this Project; this issue is waiting."
              : "This issue is waiting for the current development capacity.",
      };
    }
    if (admission.status === "impossible") {
      return {
        ...base,
        status: "unavailable",
        reason: admission.reason,
        explanation: "Jarvis could not verify this issue on the latest admission check.",
      };
    }
    if (admission.status === "ineligible") {
      return {
        ...base,
        status: "ineligible",
        reason: admission.reason,
        explanation: "This issue does not match the active workflow rule.",
      };
    }
    if (admission.status === "blocked") {
      if (snapshot.reason === "ready-label-missing") {
        return {
          ...base,
          status: "waiting",
          reason: snapshot.reason,
          explanation: "Waiting for the configured readiness label before this issue can start.",
        };
      }
      if (blockerRefs.length > 0) {
        return {
          ...base,
          status: "blocked",
          reason: "open-native-blockers",
          explanation: `Blocked by ${blockerRefs.length} open GitHub native dependenc${blockerRefs.length === 1 ? "y" : "ies"}.`,
        };
      }
      return {
        ...base,
        status: "unavailable",
        reason: admission.reason,
        explanation: "Jarvis could not verify this issue on the latest admission check.",
      };
    }
  }

  if (snapshot.admittedAt !== null) {
    return {
      ...base,
      status: "ineligible",
      reason: "already-admitted",
      explanation: "This issue has already been admitted and will not start twice.",
    };
  }

  if (snapshot.reason === "ready-label-missing") {
    return {
      ...base,
      status: "waiting",
      reason: snapshot.reason,
      explanation: "Waiting for the configured readiness label before this issue can start.",
    };
  }
  if (snapshot.reason === "open-native-blockers" && blockerRefs.length > 0) {
    return {
      ...base,
      status: "blocked",
      reason: snapshot.reason,
      explanation: `Blocked by ${blockerRefs.length} open GitHub native dependenc${blockerRefs.length === 1 ? "y" : "ies"}.`,
    };
  }
  if (snapshot.reason === "work-item-closed" || snapshot.reason === "work-item-is-pull-request") {
    return {
      ...base,
      status: "ineligible",
      reason: snapshot.reason,
      explanation:
        snapshot.reason === "work-item-closed"
          ? "This GitHub issue is closed."
          : "Pull requests cannot be admitted as work items.",
    };
  }
  if (snapshot.status === "impossible") {
    return {
      ...base,
      status: "unavailable",
      reason: snapshot.reason,
      explanation: "Jarvis could not verify this issue on the latest poll.",
    };
  }
  if (snapshot.status === "ready" && !snapshot.ruleMatches) {
    return {
      ...base,
      status: "ineligible",
      reason: "rule-not-matched",
      explanation: "The issue is ready in GitHub but does not match an active workflow rule.",
    };
  }
  if (input.paused && snapshot.status === "ready") {
    return {
      ...base,
      status: "waiting",
      reason: "project-paused",
      explanation: "New work is paused. Resume the Project to admit this issue.",
    };
  }
  if (input.hasActiveExecution && snapshot.status === "ready") {
    return {
      ...base,
      status: "waiting",
      reason: "execution-active",
      explanation: "An execution is already active for this Project; this issue is waiting.",
    };
  }
  if (snapshot.status === "ready") {
    return {
      ...base,
      status: "eligible",
      reason: snapshot.reason,
      explanation:
        "Eligible: the readiness label is present and there are no open native blockers.",
    };
  }
  return {
    ...base,
    status: "unavailable",
    reason: snapshot.reason,
    explanation: "Jarvis could not determine whether this issue can start.",
  };
}

function aggregatePolling(
  paused: boolean,
  rows: readonly GitHubPollingStatus[],
): ProjectOverview["polling"] {
  const lastPollAt =
    rows
      .map((row) => row.lastPollAt)
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null;
  if (paused) return { state: "paused", lastPollAt, errorReason: null };
  const failed = rows.find((row) => row.state === "failed");
  if (failed !== undefined) {
    return { state: "failed", lastPollAt, errorReason: failed.errorReason };
  }
  if (rows.some((row) => row.state === "reconnecting")) {
    return { state: "reconnecting", lastPollAt, errorReason: null };
  }
  return {
    state: rows.length === 0 ? "unavailable" : "live",
    lastPollAt,
    errorReason: null,
  };
}

function overviewStatusFor(
  projectStatus: ProjectRow["status"],
  activeExecutionCount: number,
  pollingState: ProjectOverview["polling"]["state"],
  lastWorkFailed: boolean,
): ProjectOverview["status"] {
  if (projectStatus === "paused") return "paused";
  if (projectStatus === "degraded" || pollingState === "failed") return "degraded";
  if (projectStatus === "draft" || projectStatus === "invalid" || projectStatus === "archived") {
    return "draft";
  }
  return activeExecutionCount > 0 ? "running" : lastWorkFailed ? "degraded" : "ready";
}

function overviewStages(
  pollingState: ProjectOverview["polling"]["state"],
  active: boolean,
  eligible: boolean,
  projectStatus: ProjectRow["status"],
): ProjectOverviewStage[] {
  return [
    {
      id: "github",
      label: "GitHub",
      status:
        pollingState === "live" || pollingState === "paused"
          ? "ready"
          : pollingState === "reconnecting"
            ? "active"
            : "unavailable",
      detail:
        pollingState === "paused" ? "Polling paused with the Project." : "Issues and dependencies",
    },
    {
      id: "rules",
      label: "Rules",
      status:
        projectStatus === "active" || projectStatus === "paused" || projectStatus === "degraded"
          ? "ready"
          : "unavailable",
      detail: "Workflow eligibility",
    },
    {
      id: "development",
      label: "Development",
      status: active ? "active" : eligible ? "ready" : "waiting",
      detail: active ? "Active execution" : "One issue at a time",
    },
    {
      id: "pull-request",
      label: "Pull Request",
      status: "waiting",
      detail: "Created after development completes",
    },
  ];
}

function nextOverviewStep(
  status: ProjectOverview["status"],
  active: boolean,
  eligible: boolean,
  pollingState: ProjectOverview["polling"]["state"],
  lastWorkFailed: boolean,
): string {
  if (status === "draft") return "Vérifiez la configuration avant d’activer ce projet.";
  if (status === "paused") return "Reprenez le projet pour autoriser de nouveaux départs.";
  if (!active && lastWorkFailed)
    return "Ouvrez le dernier travail pour examiner l’échec et le résultat conservé.";
  if (status === "degraded" || pollingState === "failed")
    return "Vérifiez la connexion GitHub puis relancez la surveillance.";
  if (active) return "Suivez l’exécution de développement en cours.";
  if (eligible) return "Jarvis prendra en charge la première issue éligible.";
  return "En attente d’une issue éligible.";
}

function readinessHelp(
  project: ProjectRow,
  snapshots: readonly WorkItemReadinessSnapshot[],
): string {
  const labels = new Set(
    project.portableConfig.modules
      .filter((module) => module.moduleId === "jarvis.module.github")
      .map((module) => module.configuration?.["readyLabel"])
      .filter((label): label is string => typeof label === "string" && label.trim() !== ""),
  );
  for (const snapshot of snapshots) {
    if (snapshot.tag?.trim()) labels.add(snapshot.tag.trim());
  }
  if (labels.size === 0) labels.add("ready-for-agent");
  return `Une issue ouverte peut démarrer avec le label ${[...labels].map((label) => `“${label}”`).join(" ou ")} et sans bloqueur GitHub natif ouvert.`;
}

function validateBindingReferences(
  current: ProjectRow,
  bindings: ProjectBindings,
  candidates: readonly ProjectResourceCandidate[],
  modules: ModuleHost,
): void {
  validateBindingEnvironmentProfiles(bindings.slots);
  validateSlotBindings(
    current.portableConfig,
    bindings.slots,
    candidates,
    modules,
    "project.bindings-invalid",
  );
}

const SENSITIVE_ENVIRONMENT_NAME =
  /(?:secret|token|password|passwd|credential|private[_-]?key|api[_-]?key)/i;
const SENSITIVE_ENVIRONMENT_VALUE =
  /(?:\b(?:github_pat_[A-Za-z0-9_]+|gh[opsu]_[A-Za-z0-9]+|sk-[A-Za-z0-9]+|bearer\s+\S+|token=|password=)|\/(?:\.codex\/(?:auth|credentials)|credentials|auth)(?:\/|$))/i;

function validateBindingEnvironmentProfiles(bindings: ProjectBindings["slots"]): void {
  for (const [slot, binding] of Object.entries(bindings)) {
    if (binding.environment === undefined) continue;
    if (binding.kind !== "runtime") {
      throw new EngineError(
        "project.bindings-invalid",
        400,
        `/slots/${slot}/environment is only valid for a runtime Local Binding.`,
      );
    }
    if (
      Object.keys(binding.environment).some((name) => SENSITIVE_ENVIRONMENT_NAME.test(name)) ||
      Object.values(binding.environment).some((value) => SENSITIVE_ENVIRONMENT_VALUE.test(value))
    ) {
      throw new EngineError(
        "project.bindings-invalid",
        400,
        `/slots/${slot}/environment must not contain secrets, credentials, or authentication-file paths.`,
      );
    }
  }
}

function validateSlotBindings(
  configuration: StoredPortableProjectConfiguration,
  bindings: ProjectBindings["slots"],
  candidates: readonly ProjectResourceCandidate[],
  modules: ModuleHost,
  code: "project.config-invalid" | "project.bindings-invalid",
): void {
  for (const [slot, binding] of Object.entries(bindings)) {
    if (configuration.slots[slot] === undefined) {
      throw new EngineError(
        code,
        400,
        `/slots/${slot} is not declared by the Portable Configuration.`,
      );
    }
    const requiredCapabilities = slotRequirements(configuration, modules, slot).capabilities;
    const eligible = candidates.some(
      (candidate) =>
        candidate.ref === binding.ref &&
        candidate.kind === binding.kind &&
        requiredCapabilities.every((capability) => candidate.capabilities.includes(capability)),
    );
    if (!eligible) {
      throw new EngineError(
        code,
        400,
        `/slots/${slot} must reference an explicitly granted resource with every required capability: ${requiredCapabilities.join(", ")}.`,
      );
    }
  }
}

function eligibleCandidates(
  projectId: string,
  configuration: StoredPortableProjectConfiguration,
  modules: ModuleHost,
  grants: ProjectResourceGrantPort,
): readonly ProjectResourceCandidate[] {
  return projectResourceCandidates(configuration, modules, grants.grantedToProject(projectId));
}

function resourceChoices(
  project: ProjectRow,
  configuration: StoredPortableProjectConfiguration,
  modules: ModuleHost,
  grantedResources: readonly ProjectResourceGrant[],
  runtimes?: LocalAgentRuntimeRegistry,
): ProjectResourceChoices {
  const grantedCandidates = grantedResources.map(({ candidate }) => candidate);
  const statusByCandidate = new Map(
    grantedResources.map(({ candidate, status }) => [resourceCandidateId(candidate), status]),
  );
  const scopedCandidates = projectResourceCandidates(configuration, modules, grantedCandidates)
    .slice()
    .sort(compareResourceCandidate);
  const slots = Object.keys(configuration.slots)
    .sort((left, right) => left.localeCompare(right))
    .map((slotId) => {
      const requirements = slotRequirements(configuration, modules, slotId);
      const requiredCapabilities = requirements.capabilities;
      const binding = project.slotBindings[slotId];
      const candidates = scopedCandidates.filter(
        (candidate) =>
          (statusByCandidate.get(resourceCandidateId(candidate)) ?? "available") === "available" &&
          requiredCapabilities.every((capability) => candidate.capabilities.includes(capability)) &&
          // Same ref, wrong kind: this Slot's own binding says which kind that
          // ref must be. Named as ineligible (ADR 0014), never left eligible.
          !(
            binding !== undefined &&
            candidate.ref === binding.ref &&
            candidate.kind !== binding.kind
          ),
      );
      const sameResource =
        binding === undefined
          ? undefined
          : scopedCandidates.find(
              (candidate) => candidate.kind === binding.kind && candidate.ref === binding.ref,
            );
      const bound =
        binding === undefined
          ? undefined
          : candidates.find(
              (candidate) => candidate.kind === binding.kind && candidate.ref === binding.ref,
            );
      const status =
        bound !== undefined
          ? ("bound" as const)
          : binding !== undefined && sameResource === undefined
            ? ("inaccessible" as const)
            : binding !== undefined
              ? ("incompatible" as const)
              : candidates.length > 0
                ? ("available" as const)
                : scopedCandidates.length > 0
                  ? ("incompatible" as const)
                  : ("missing" as const);
      const affected = requirements.instanceIds;
      const impact =
        affected.length === 0
          ? `Project behavior requiring Slot ${slotId} cannot run without ${requiredCapabilities.join(
              ", ",
            )}.`
          : `Module Instances ${affected.join(
              ", ",
            )} cannot run their configured behavior without ${requiredCapabilities.join(", ")}.`;
      const ineligibleGrantedResources = ineligibleGrantedResourcesFor(
        scopedCandidates,
        candidates,
        requiredCapabilities,
        binding,
        (candidate) => statusByCandidate.get(resourceCandidateId(candidate)),
      );
      return {
        slotId,
        requiredCapabilities,
        candidates,
        status,
        impact,
        repairAction: repairAction(status, slotId, requiredCapabilities),
        ...(ineligibleGrantedResources.length === 0 ? {} : { ineligibleGrantedResources }),
      };
    });
  const eligibleIds = new Set(slots.flatMap((slot) => slot.candidates.map(resourceCandidateId)));
  return {
    items: scopedCandidates.filter((candidate) => eligibleIds.has(resourceCandidateId(candidate))),
    ...(runtimes === undefined
      ? {}
      : {
          agentRuntimes: projectAgentRuntimeChoices(
            project,
            configuration,
            slots,
            runtimes.descriptors(),
          ),
        }),
    slots,
  };
}

function slotRequirements(
  configuration: StoredPortableProjectConfiguration,
  modules: ModuleHost,
  slotId: string,
): { readonly capabilities: string[]; readonly instanceIds: string[] } {
  const slot = configuration.slots[slotId];
  if (slot === undefined) return { capabilities: [], instanceIds: [] };
  const capabilities = new Set([slot.requires]);
  const instanceIds = new Set<string>();
  for (const instance of configuration.modules.filter((candidate) => candidate.enabled)) {
    for (const requirement of modules.composition(instance.moduleId)?.requires ?? []) {
      if (requirement.resolution !== undefined || requirement.binding === undefined) continue;
      const reference =
        instance.bindings?.[requirement.binding] ??
        (requirement.binding === "agentRuntime" ? instance.runtimeSlot : undefined);
      if (reference !== slotId) continue;
      capabilities.add(requirement.id);
      instanceIds.add(instance.instanceId);
    }
  }
  return { capabilities: [...capabilities].sort(), instanceIds: [...instanceIds].sort() };
}

function repairAction(
  status: ProjectResourceChoices["slots"][number]["status"],
  slotId: string,
  capabilities: readonly string[],
): string {
  const required = capabilities.join(", ");
  switch (status) {
    case "bound":
      return `No repair is needed for ${slotId}.`;
    case "available":
      return `Choose an eligible Project resource for ${slotId}.`;
    case "inaccessible":
      return `Restore Project access to the bound resource for ${slotId}, or choose another eligible resource.`;
    case "incompatible":
      return `Choose or grant a resource that provides every required capability: ${required}.`;
    case "missing":
      return `Grant a resource with ${required} to this Project, then reload Project Resources.`;
  }
  const exhaustive: never = status;
  return exhaustive;
}

/**
 * ADR 0014: names every candidate already granted to this Project (present in
 * `scopedCandidates`, itself bounded by `ProjectResourceGrantPort` — never a
 * resource this Project has no grant for) that this Slot's own eligibility
 * filter excluded from `candidates`, together with the Engine's reason. A
 * resource outside `scopedCandidates` is never considered here, so it can
 * never be named, counted or hinted at.
 */
function ineligibleGrantedResourcesFor(
  scopedCandidates: readonly ProjectResourceCandidate[],
  eligibleCandidates: readonly ProjectResourceCandidate[],
  requiredCapabilities: readonly string[],
  binding: { readonly kind: string; readonly ref: string } | undefined,
  statusFor: (candidate: ProjectResourceCandidate) => ProjectResourceGrant["status"],
): readonly ProjectIneligibleResource[] {
  return scopedCandidates
    .filter((candidate) => !eligibleCandidates.includes(candidate))
    .flatMap((candidate) => {
      const reason = ineligibilityReason(
        candidate,
        requiredCapabilities,
        binding,
        statusFor(candidate),
      );
      return reason === undefined ? [] : [{ candidate, reason }];
    })
    .sort((left, right) => compareResourceCandidate(left.candidate, right.candidate));
}

function ineligibilityReason(
  candidate: ProjectResourceCandidate,
  requiredCapabilities: readonly string[],
  binding: { readonly kind: string; readonly ref: string } | undefined,
  status: ProjectResourceGrant["status"],
): string | undefined {
  if (status !== undefined && status !== "available") {
    return `This resource is ineligible because its status is "${status}".`;
  }
  if (binding !== undefined && candidate.ref === binding.ref && candidate.kind !== binding.kind) {
    return `This Slot's binding expects kind "${binding.kind}" for ref ${binding.ref}, but the resource granted under that ref is kind "${candidate.kind}".`;
  }
  const satisfied = requiredCapabilities.filter((capability) =>
    candidate.capabilities.includes(capability),
  );
  if (satisfied.length === requiredCapabilities.length) return undefined;
  if (satisfied.length === 0) {
    return `This resource provides none of the required capabilities: ${requiredCapabilities.join(", ")}.`;
  }
  return `This resource provides only ${satisfied.join(", ")} of the required capabilities: ${requiredCapabilities.join(", ")}.`;
}

function resourceGrantDetails(
  grants: ProjectResourceGrantPort,
  projectId: string,
): readonly ProjectResourceGrant[] {
  if ("grantedResourceDetails" in grants && typeof grants.grantedResourceDetails === "function") {
    return (grants as ProjectResourceGrantDetailsPort).grantedResourceDetails(projectId);
  }
  return grants.grantedToProject(projectId).map((candidate) => ({ candidate }));
}

function resourceCandidateId(candidate: ProjectResourceCandidate): string {
  return `${candidate.kind}/${candidate.ref}`;
}

function compareResourceCandidate(
  left: ProjectResourceCandidate,
  right: ProjectResourceCandidate,
): number {
  return resourceCandidateId(left).localeCompare(resourceCandidateId(right));
}

function resolvePortableConfig(
  repositoryPath: string,
  supplied: unknown,
  discovery: ReturnType<typeof discoverRepository>,
): { configuration: StoredPortableProjectConfiguration; isDiscoveredDraft: boolean } {
  const committed = readCommittedConfig(repositoryPath);
  if (committed !== undefined) {
    return { configuration: committed, isDiscoveredDraft: false };
  }
  if (supplied !== undefined) {
    validatePortableConfig(supplied);
    return {
      configuration: supplied as PortableProjectConfiguration,
      isDiscoveredDraft: false,
    };
  }
  return { configuration: discovery.suggested, isDiscoveredDraft: true };
}

function readCommittedConfig(
  repositoryPath: string,
): StoredPortableProjectConfiguration | undefined {
  const file = join(repositoryPath, PROJECT_YAML);
  let stats;
  try {
    stats = statSync(file);
  } catch {
    return undefined;
  }
  if (!stats.isFile())
    throw configInvalid(".jarvis/project.yaml exists but is not a regular file.");
  if (stats.size > MAX_PROJECT_YAML_BYTES) {
    throw configInvalid(
      `.jarvis/project.yaml is ${stats.size} bytes; the engine reads at most ${MAX_PROJECT_YAML_BYTES}. Trim it and import again.`,
    );
  }
  let document: unknown;
  try {
    document = parseYaml(readFileSync(file, "utf8"));
  } catch {
    throw configInvalid(".jarvis/project.yaml could not be read as valid YAML.");
  }
  validatePortableConfig(document);
  return document as StoredPortableProjectConfiguration;
}

function configInvalid(reason: string): EngineError {
  return new EngineError("project.config-invalid", 400, `Rejected ${reason}`);
}

function allocateProjectId(
  config: StoredPortableProjectConfiguration,
  store: ProjectStore,
): string {
  const base = slugify(config.metadata.id || "project");
  if (!store.existsById(base)) return base;
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!store.existsById(candidate)) return candidate;
  }
  throw new EngineError("system.internal-error", 500, "No free project id could be allocated.");
}

/**
 * `requestAttempts`/`factDeliveries` are internal-only: the composition graph
 * projects them directly from the in-process validation report, and the
 * `ProjectValidationReportV1` wire contract predates them and never declares
 * them (a struct that does crashes the generated Swift client's synthesized
 * destructor). Endpoints that send a `ProjectValidationReport` over the wire
 * strip them first; `compositionGraph` reads the untrimmed report instead.
 */
function toWireValidationReport(report: ProjectValidationReport): ProjectValidationReport {
  const { requestAttempts, factDeliveries, ...wire } = report;
  return wire;
}

function repositoryPathError(error: unknown): EngineError {
  if (error instanceof RepositoryPathError) {
    return new EngineError("repository.path-invalid", 400, error.message);
  }
  if (error instanceof EngineError) return error;
  return new EngineError("system.internal-error", 500, "The repository could not be inspected.");
}

function notFound(id: string): EngineError {
  return new EngineError(
    "project.not-found",
    404,
    `No project with id "${id}" in this installation.`,
  );
}

function activationRejected(
  code: "project.activation-not-validated" | "project.activation-report-stale",
  projectId: string,
  reason: string,
): EngineError {
  return new EngineError(
    code,
    409,
    `Project "${projectId}" ${reason}. Request a fresh POST /v1/projects/${projectId}/validation-report and retry activation with its compositionFingerprint.`,
  );
}

function toSummary(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    moduleCount: "modules" in row.portableConfig ? (row.portableConfig.modules?.length ?? 0) : 0,
    activeExecutions: 0,
  };
}

function toDetail(
  row: ProjectRow,
  repositoryAccessibility: RepositoryAccessibilityPort,
): ProjectDetail {
  const accessible = repositoryAccessibility.isAccessibleDirectory(row.repositoryPath);
  let remotes: ReturnType<typeof readRepositoryRemotes> = [];
  try {
    if (accessible) remotes = readRepositoryRemotes(row.repositoryPath);
  } catch {
    // A removed or inaccessible checkout has no current remote to display.
  }
  const bindingStatus: BindingStatus = Object.fromEntries(
    row.portableConfig.repositories.map((repository) => {
      const url = remotes.find((remote) => remote.name === repository.remote)?.url;
      return [
        repository.id,
        {
          path: row.repositoryPath,
          accessible,
          bookmarkRef: row.bookmarkRef,
          remoteUrl: url === undefined ? null : publicRemoteUrl(url),
        },
      ];
    }),
  );
  return { ...toSummary(row), portableConfig: row.portableConfig, bindingStatus };
}

function toBindings(row: ProjectRow): ProjectBindings {
  return {
    apiVersion: "jarvis.dev/project-bindings/v1",
    kind: "ProjectBindings",
    projectId: row.id,
    repositories: Object.fromEntries(
      row.portableConfig.repositories.map((repository) => [
        repository.id,
        {
          path: row.repositoryPath,
          bookmarkRef: row.bookmarkRef,
        },
      ]),
    ),
    slots: row.slotBindings,
  };
}
