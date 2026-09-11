import type {
  GitHubApi,
  ModuleHandlerCapabilities,
  PollCursorCapability,
} from "../../../../packages/module-sdk/src/index.js";
import type { ModuleHost } from "../../../../packages/kernel/src/module-host.js";
import type { IdGenerator } from "../../../../packages/kernel/src/id-generator.js";
import {
  latestGitHubIssueEvent,
  translateGitHubIssueEvents,
  type GitHubIssueEventPosition,
  type GitHubIssueEventTranslation,
} from "../../../../packages/modules/github/src/translation.js";
import type { ProjectModuleInstanceConfiguration } from "../../../../packages/project-runtime/src/project-types.js";
import type { ProjectStore, ResolvedProjectSnapshot } from "../projects/store.js";
import type { EventPublisher } from "./publisher.js";

const GITHUB_MODULE_ID = "jarvis.module.github";
const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const DEFAULT_TICK_INTERVAL_MS = 1_000;
const EMPTY_BOOTSTRAP_POSITION = {
  externalEventId: "bootstrap-empty",
  happenedAt: "1970-01-01T00:00:00.000Z",
} as const;

export interface GitHubPollingDependencies {
  readonly projects: Pick<ProjectStore, "list" | "getResolvedProject">;
  readonly modules: Pick<ModuleHost, "composition">;
  readonly capabilities: {
    resolve(
      projectId: string,
      moduleInstanceId: string,
      moduleId: string,
    ): ModuleHandlerCapabilities;
  };
  readonly publisher: Pick<EventPublisher, "publish">;
  readonly transaction: <Result>(operation: () => Result) => Result;
  readonly ids: Pick<IdGenerator, "next">;
  readonly pollIntervalMs?: number;
}

/** Polls active Project-bound GitHub Module Instances without retaining credentials. */
export class GitHubPollingScheduler {
  private readonly inFlight = new Set<string>();
  private readonly nextPollAt = new Map<string, number>();

  public constructor(private readonly dependencies: GitHubPollingDependencies) {}

  public start(): () => void {
    void this.tick();
    const timer = setInterval(() => void this.tick(), DEFAULT_TICK_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  public async tick(): Promise<void> {
    const now = Date.now();
    for (const project of this.dependencies.projects.list()) {
      if (project.status !== "active") continue;
      const snapshot = this.dependencies.projects.getResolvedProject(project.id);
      if (snapshot === undefined) continue;
      for (const instance of snapshot.moduleInstances) {
        if (!this.shouldPoll(instance)) continue;
        const key = `${project.id}:${instance.instanceId}`;
        if (this.inFlight.has(key)) continue;

        const intervalMs = effectivePollIntervalMs(instance, this.dependencies.pollIntervalMs);
        if (now < (this.nextPollAt.get(key) ?? 0)) continue;
        this.nextPollAt.set(key, now + intervalMs);
        this.inFlight.add(key);
        void this.pollInstance(project.id, snapshot, instance).finally(() =>
          this.inFlight.delete(key),
        );
      }
    }
  }

  private shouldPoll(instance: ProjectModuleInstanceConfiguration): boolean {
    return (
      instance.enabled &&
      instance.moduleId === GITHUB_MODULE_ID &&
      this.dependencies.modules.composition(instance.moduleId) !== undefined
    );
  }

  private async pollInstance(
    projectId: string,
    snapshot: ResolvedProjectSnapshot,
    instance: ProjectModuleInstanceConfiguration,
  ): Promise<void> {
    let capabilities: ModuleHandlerCapabilities;
    try {
      capabilities = this.dependencies.capabilities.resolve(
        projectId,
        instance.instanceId,
        instance.moduleId,
      );
    } catch {
      logPollingFailure(projectId, instance.instanceId, "capability", "capability-unavailable");
      return;
    }
    const githubApi = capabilities.githubApi;
    if (githubApi === undefined) {
      logPollingFailure(projectId, instance.instanceId, "capability", "capability-unavailable");
      return;
    }
    const pollCursor = capabilities.pollCursor;
    if (pollCursor === undefined) {
      logPollingFailure(projectId, instance.instanceId, "capability", "capability-unavailable");
      return;
    }
    const externalMappings = capabilities.externalMappings;
    if (externalMappings === undefined) {
      logPollingFailure(projectId, instance.instanceId, "capability", "capability-unavailable");
      return;
    }

    const repositories = configuredRepositories(instance.configuration);
    await Promise.all(
      repositories.map((repositoryId, index) => {
        const portableRepositoryId = portableRepository(snapshot, repositoryId, index);
        return this.pollRepository(
          projectId,
          instance.instanceId,
          repositoryId,
          portableRepositoryId,
          githubApi,
          pollCursor,
          externalMappings,
          instance.configuration,
        );
      }),
    );
  }

  private async pollRepository(
    projectId: string,
    moduleInstanceId: string,
    githubRepositoryId: string,
    repositoryId: string | undefined,
    githubApi: GitHubApi,
    pollCursor: PollCursorCapability,
    externalMappings: NonNullable<ModuleHandlerCapabilities["externalMappings"]>,
    configuration: Readonly<Record<string, unknown>> | undefined,
  ): Promise<void> {
    try {
      const repositoryParts = githubRepositoryId.split("/").filter((part) => part !== "");
      if (repositoryParts.length !== 2) {
        throw new Error("invalid repository");
      }
      const [owner, repository] = repositoryParts;
      if (owner === undefined || repository === undefined) throw new Error("invalid repository");
      const response = await githubApi.get(issueEventsPath(githubRepositoryId));
      if (repositoryId === undefined) return;
      const cursor = pollCursor.read(repositoryId);
      const newest = latestGitHubIssueEvent(response);
      const translated = translateGitHubIssueEvents(response, owner, repository).sort(
        compareEvents,
      );
      if (cursor !== undefined) {
        const afterCursor = translated.filter((event) => isAfterCursor(event, cursor));
        if (afterCursor.length === 0) return;
        const pending = afterCursor.filter(
          (event) => externalMappings.read(event.externalEventId) === undefined,
        );
        publishAndAdvance(
          pending,
          afterCursor[afterCursor.length - 1]!,
          projectId,
          moduleInstanceId,
          repositoryId,
          pollCursor,
          externalMappings,
          this.dependencies,
        );
        return;
      }

      const bootstrapEvents =
        bootstrapLabelPolicy(configuration) === "emit-existing"
          ? existingBootstrapEvents(translated)
          : [];
      const pending = bootstrapEvents.filter(
        (event) => externalMappings.read(event.externalEventId) === undefined,
      );
      publishAndAdvance(
        pending,
        newest ?? EMPTY_BOOTSTRAP_POSITION,
        projectId,
        moduleInstanceId,
        repositoryId,
        pollCursor,
        externalMappings,
        this.dependencies,
      );
    } catch {
      logPollingFailure(projectId, moduleInstanceId, githubRepositoryId, "provider-call-failed");
    }
  }
}

function configuredRepositories(
  configuration: Readonly<Record<string, unknown>> | undefined,
): readonly string[] {
  const repositories = configuration?.["repositories"];
  if (!Array.isArray(repositories)) return [];
  return repositories.filter(
    (repository): repository is string =>
      typeof repository === "string" && repository.trim() !== "",
  );
}

function portableRepository(
  snapshot: ResolvedProjectSnapshot,
  configuredRepositoryId: string,
  configuredIndex: number,
): string | undefined {
  const declared = snapshot.composition.repositories.find(
    (repository) => repository.id === configuredRepositoryId,
  );
  if (declared !== undefined) return declared.id;
  return snapshot.composition.repositories.length === 1 && configuredIndex === 0
    ? snapshot.composition.repositories[0]?.id
    : undefined;
}

function bootstrapLabelPolicy(
  configuration: Readonly<Record<string, unknown>> | undefined,
): "ignore-existing" | "emit-existing" {
  return configuration?.["bootstrapLabelPolicy"] === "emit-existing"
    ? "emit-existing"
    : "ignore-existing";
}

function existingBootstrapEvents(
  events: readonly GitHubIssueEventTranslation[],
): readonly GitHubIssueEventTranslation[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (event.issueState === "closed") return false;
    const key = `${event.payload.workItemRef}\u0000${event.payload.tag}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function publishAndAdvance(
  events: readonly GitHubIssueEventTranslation[],
  position: GitHubIssueEventPosition,
  projectId: string,
  moduleInstanceId: string,
  repositoryId: string,
  pollCursor: PollCursorCapability,
  externalMappings: NonNullable<ModuleHandlerCapabilities["externalMappings"]>,
  dependencies: Pick<GitHubPollingDependencies, "publisher" | "transaction" | "ids">,
): void {
  dependencies.transaction(() => {
    for (const event of events) {
      const envelope = dependencies.publisher.publish({
        type: "scm.work-item.tag-added",
        version: 1,
        kind: "fact",
        projectId,
        repositoryId,
        producer: { moduleId: GITHUB_MODULE_ID, moduleInstanceId },
        subject: { type: "work-item", ref: event.payload.workItemRef },
        correlationId: `corr_${dependencies.ids.next()}`,
        causationId: null,
        payload: { ...event.payload },
        metadata: { externalObservedAt: event.happenedAt },
      });
      externalMappings.recordResource({
        idempotencyKey: event.externalEventId,
        resourceRef: envelope.id,
      });
    }
    pollCursor.write({
      repositoryId,
      externalEventId: position.externalEventId,
      eventTimestamp: position.happenedAt,
    });
  });
}

function effectivePollIntervalMs(
  instance: ProjectModuleInstanceConfiguration,
  overrideMs: number | undefined,
): number {
  if (overrideMs !== undefined) return overrideMs;
  const seconds = instance.configuration?.["pollIntervalSeconds"];
  return typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 15
    ? seconds * 1_000
    : DEFAULT_POLL_INTERVAL_SECONDS * 1_000;
}

function issueEventsPath(repositoryId: string): string {
  const segments = repositoryId.split("/").filter((segment) => segment !== "");
  const encoded = segments.map((segment) => encodeURIComponent(segment));
  return `/repos/${encoded.join("/")}/issues/events`;
}

function isAfterCursor(
  event: { readonly externalEventId: string; readonly happenedAt: string },
  cursor: ReturnType<PollCursorCapability["read"]>,
): boolean {
  if (cursor === undefined) return true;
  if (event.happenedAt !== cursor.eventTimestamp) {
    return event.happenedAt > cursor.eventTimestamp;
  }
  return compareExternalEventIds(event.externalEventId, cursor.externalEventId) > 0;
}

function compareEvents(
  left: { readonly externalEventId: string; readonly happenedAt: string },
  right: { readonly externalEventId: string; readonly happenedAt: string },
): number {
  return left.happenedAt === right.happenedAt
    ? compareExternalEventIds(left.externalEventId, right.externalEventId)
    : left.happenedAt.localeCompare(right.happenedAt);
}

function compareExternalEventIds(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return left.localeCompare(right);
}

function logPollingFailure(
  projectId: string,
  moduleInstanceId: string,
  repositoryId: string,
  reason: string,
): void {
  process.stderr.write(
    `jarvis-engine: GitHub polling failed project=${projectId} moduleInstance=${moduleInstanceId} repository=${repositoryId} reason=${reason}\n`,
  );
}
