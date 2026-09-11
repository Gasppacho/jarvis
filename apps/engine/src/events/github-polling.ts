import type {
  GitHubApi,
  ModuleHandlerCapabilities,
  PollCursorCapability,
} from "../../../../packages/module-sdk/src/index.js";
import type { Clock } from "../../../../packages/kernel/src/clock.js";
import type { ModuleHost } from "../../../../packages/kernel/src/module-host.js";
import type { IdGenerator } from "../../../../packages/kernel/src/id-generator.js";
import { GitHubApiError } from "../../../../packages/modules/github/src/api-client.js";
import {
  GitHubTranslationError,
  latestGitHubIssueEvent,
  translateGitHubIssueEvents,
  type GitHubIssueEventPosition,
  type GitHubIssueEventTranslation,
} from "../../../../packages/modules/github/src/translation.js";
import type { ProjectModuleInstanceConfiguration } from "../../../../packages/project-runtime/src/project-types.js";
import type { ProjectStore, ResolvedProjectSnapshot } from "../projects/store.js";
import type { EventPublisher } from "./publisher.js";
import { failpoint } from "../test-support/failpoint.js";

declare const __JARVIS_TEST_HOOKS__: boolean | undefined;

const GITHUB_MODULE_ID = "jarvis.module.github";
const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const DEFAULT_TICK_INTERVAL_MS = 1_000;
/** Re-read this much history on every poll after the durable cursor. */
const RECOVERY_WINDOW_MS = 5 * 60 * 1_000;
/** GitHub allows 100 events per page; this caps one poll at ten requests. */
const RECOVERY_PAGE_SIZE = 100;
const RECOVERY_MAX_PAGES = 10;
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
  readonly clock: Pick<Clock, "now">;
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
    const now = this.dependencies.clock.now().getTime();
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
      if (repositoryId === undefined) {
        await githubApi.get(issueEventsPath(githubRepositoryId));
        return;
      }
      const cursor = pollCursor.read(repositoryId);
      const observed = await readIssueEvents(
        githubApi,
        githubRepositoryId,
        owner,
        repository,
        cursor,
      );
      if (typeof __JARVIS_TEST_HOOKS__ === "undefined" || __JARVIS_TEST_HOOKS__) {
        failpoint("after-github-poll-read");
      }
      const translated = observed.events.sort(compareEvents);
      if (cursor !== undefined) {
        const recoveryBoundary = Date.parse(cursor.eventTimestamp) - RECOVERY_WINDOW_MS;
        const inWindow = translated.filter(
          (event) => Date.parse(event.happenedAt) >= recoveryBoundary,
        );
        const pending = inWindow.filter(
          (event) => externalMappings.read(event.externalEventId) === undefined,
        );
        const newestAfterCursor =
          observed.newest !== undefined && isAfterCursor(observed.newest, cursor);
        const position = newestAfterCursor ? observed.newest! : cursorPosition(cursor);
        if (pending.length === 0 && !newestAfterCursor) return;
        publishAndAdvance(
          pending,
          position,
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
        observed.newest ?? EMPTY_BOOTSTRAP_POSITION,
        projectId,
        moduleInstanceId,
        repositoryId,
        pollCursor,
        externalMappings,
        this.dependencies,
      );
    } catch (error: unknown) {
      logPollingFailure(
        projectId,
        moduleInstanceId,
        githubRepositoryId,
        classifyPollingFailure(error),
      );
    }
  }
}

interface ObservedIssueEvents {
  readonly events: GitHubIssueEventTranslation[];
  readonly newest: GitHubIssueEventPosition | undefined;
}

async function readIssueEvents(
  githubApi: GitHubApi,
  githubRepositoryId: string,
  owner: string,
  repository: string,
  cursor: ReturnType<PollCursorCapability["read"]>,
): Promise<ObservedIssueEvents> {
  if (cursor === undefined) {
    const response = await githubApi.get(issueEventsPath(githubRepositoryId));
    return {
      events: translateGitHubIssueEvents(response, owner, repository),
      newest: latestGitHubIssueEvent(response),
    };
  }

  const events: GitHubIssueEventTranslation[] = [];
  let newest: GitHubIssueEventPosition | undefined;
  const recoveryBoundary = Date.parse(cursor.eventTimestamp) - RECOVERY_WINDOW_MS;
  for (let page = 1; page <= RECOVERY_MAX_PAGES; page += 1) {
    const response = await githubApi.get(issueEventsPath(githubRepositoryId, page));
    const pageEvents = translateGitHubIssueEvents(response, owner, repository);
    if (page === 1) newest = latestGitHubIssueEvent(response);
    events.push(...pageEvents);

    const oldestTimestamp = oldestEventTimestamp(response);
    if (
      eventPageSize(response) < RECOVERY_PAGE_SIZE ||
      (oldestTimestamp !== undefined && oldestTimestamp <= recoveryBoundary)
    ) {
      break;
    }
  }
  return { events, newest };
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
      if (typeof __JARVIS_TEST_HOOKS__ === "undefined" || __JARVIS_TEST_HOOKS__) {
        failpoint("after-github-poll-mapping");
      }
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

function issueEventsPath(repositoryId: string, page?: number): string {
  const segments = repositoryId.split("/").filter((segment) => segment !== "");
  const encoded = segments.map((segment) => encodeURIComponent(segment));
  const path = `/repos/${encoded.join("/")}/issues/events`;
  return page === undefined ? path : `${path}?per_page=${RECOVERY_PAGE_SIZE}&page=${page}`;
}

function eventPageSize(response: unknown): number {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    throw new Error("invalid GitHub issue event response");
  }
  const body = (response as { readonly body?: unknown }).body;
  if (!Array.isArray(body)) throw new Error("invalid GitHub issue event response");
  return body.length;
}

function oldestEventTimestamp(response: unknown): number | undefined {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    throw new Error("invalid GitHub issue event response");
  }
  const body = (response as { readonly body?: unknown }).body;
  if (!Array.isArray(body)) throw new Error("invalid GitHub issue event response");
  const oldest = body[body.length - 1];
  if (oldest === undefined) return undefined;
  if (typeof oldest !== "object" || oldest === null || Array.isArray(oldest)) {
    throw new Error("invalid GitHub issue event response");
  }
  const createdAt = (oldest as { readonly created_at?: unknown }).created_at;
  if (typeof createdAt !== "string") throw new Error("invalid GitHub issue event response");
  const timestamp = Date.parse(createdAt);
  if (Number.isNaN(timestamp)) throw new Error("invalid GitHub issue event response");
  return timestamp;
}

function cursorPosition(
  cursor: NonNullable<ReturnType<PollCursorCapability["read"]>>,
): GitHubIssueEventPosition {
  return {
    externalEventId: cursor.externalEventId,
    happenedAt: cursor.eventTimestamp,
  };
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

type PollingFailureReason = "credential-refused" | "rate-limited" | "unavailable" | "unclassified";

function classifyPollingFailure(error: unknown): PollingFailureReason {
  if (error instanceof GitHubApiError) {
    return error.status === "unauthenticated" ? "credential-refused" : "unavailable";
  }
  if (error instanceof GitHubTranslationError) {
    if (error.code === "github.rate-limited") return "rate-limited";
    if (error.code === "github.unauthorized") return "credential-refused";
    if (error.code === "github.change-request-create-failed") return "unavailable";
    return "unclassified";
  }
  return "unclassified";
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
