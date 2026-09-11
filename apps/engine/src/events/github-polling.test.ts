import { describe, expect, it } from "vitest";
import type { GitHubApi } from "../../../../packages/module-sdk/src/index.js";
import type { ModuleCompositionMetadata } from "../../../../packages/kernel/src/module-host.js";
import type { EventEnvelope } from "../../../../packages/eventing/src/envelope.js";
import type { ProjectModuleInstanceConfiguration } from "../../../../packages/project-runtime/src/project-types.js";
import type { ProjectRow, ResolvedProjectSnapshot } from "../projects/store.js";
import { GitHubPollingScheduler } from "./github-polling.js";

const instance = {
  instanceId: "github",
  moduleId: "jarvis.module.github",
  enabled: true,
  configuration: { pollIntervalSeconds: 15, repositories: ["Gasppacho/jarvis"] },
} satisfies ProjectModuleInstanceConfiguration;

const project = {
  id: "project-a",
  name: "Project A",
  status: "active",
  portableConfig: {} as ProjectRow["portableConfig"],
  repositoryPath: "/tmp/project-a",
  bookmarkRef: null,
  slotBindings: {},
  createdAt: "2026-09-11T00:00:00.000Z",
  updatedAt: "2026-09-11T00:00:00.000Z",
} satisfies ProjectRow;

const snapshot = {
  moduleInstances: [instance],
  composition: { repositories: [{ id: "main" }] },
} as unknown as ResolvedProjectSnapshot;
const composition = {} as ModuleCompositionMetadata;

describe("GitHubPollingScheduler", () => {
  it("does not overlap a slow Module Instance and polls again after its interval", async () => {
    let calls = 0;
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const response = new Promise<void>((resolve) => (release = resolve));
    const api: GitHubApi = {
      get: async () => {
        calls += 1;
        started();
        await response;
        return { status: 200, body: [] };
      },
      request: async () => ({ status: 200, body: [] }),
    };
    const scheduler = schedulerFor(api, 1);

    await scheduler.tick();
    await startedPromise;
    await scheduler.tick();
    expect(calls).toBe(1);

    release();
    await response;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await scheduler.tick();
    expect(calls).toBe(2);
  });

  it("logs and survives a rejected provider call", async () => {
    let calls = 0;
    const api: GitHubApi = {
      get: async () => {
        calls += 1;
        throw new Error("provider unavailable");
      },
      request: async () => ({ status: 200, body: [] }),
    };
    const scheduler = schedulerFor(api, 1);

    await scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await scheduler.tick();

    expect(calls).toBe(2);
  });
});

function schedulerFor(api: GitHubApi, pollIntervalMs: number): GitHubPollingScheduler {
  return new GitHubPollingScheduler({
    projects: {
      list: () => [project],
      getResolvedProject: () => snapshot,
    },
    modules: { composition: () => composition },
    capabilities: {
      resolve: () => ({
        githubApi: api,
        pollCursor: { read: () => undefined, write: () => undefined },
        externalMappings: {
          read: () => undefined,
          recordAttempt: () => undefined,
          recordResource: () => undefined,
        },
      }),
    },
    publisher: { publish: () => null as unknown as EventEnvelope },
    transaction: (operation) => operation(),
    ids: { next: () => "id" },
    pollIntervalMs,
  });
}
