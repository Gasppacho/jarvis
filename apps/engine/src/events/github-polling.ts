import type {
  GitHubApi,
  ModuleHandlerCapabilities,
} from "../../../../packages/module-sdk/src/index.js";
import type { ModuleHost } from "../../../../packages/kernel/src/module-host.js";
import type { ProjectModuleInstanceConfiguration } from "../../../../packages/project-runtime/src/project-types.js";
import type { ProjectStore } from "../projects/store.js";

const GITHUB_MODULE_ID = "jarvis.module.github";
const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const DEFAULT_TICK_INTERVAL_MS = 1_000;

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
      for (const instance of snapshot?.moduleInstances ?? []) {
        if (!this.shouldPoll(instance)) continue;
        const key = `${project.id}:${instance.instanceId}`;
        if (this.inFlight.has(key)) continue;

        const intervalMs = effectivePollIntervalMs(instance, this.dependencies.pollIntervalMs);
        if (now < (this.nextPollAt.get(key) ?? 0)) continue;
        this.nextPollAt.set(key, now + intervalMs);
        this.inFlight.add(key);
        void this.pollInstance(project.id, instance).finally(() => this.inFlight.delete(key));
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
    instance: ProjectModuleInstanceConfiguration,
  ): Promise<void> {
    let githubApi: GitHubApi | undefined;
    try {
      githubApi = this.dependencies.capabilities.resolve(
        projectId,
        instance.instanceId,
        instance.moduleId,
      ).githubApi;
    } catch (error) {
      logPollingFailure(projectId, instance.instanceId, "capability", "capability-unavailable");
      return;
    }
    if (githubApi === undefined) {
      logPollingFailure(projectId, instance.instanceId, "capability", "capability-unavailable");
      return;
    }

    const repositories = configuredRepositories(instance.configuration);
    await Promise.all(
      repositories.map(async (repositoryId) => {
        try {
          await githubApi!.get(issueEventsPath(repositoryId));
        } catch {
          logPollingFailure(projectId, instance.instanceId, repositoryId, "provider-call-failed");
        }
      }),
    );
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
