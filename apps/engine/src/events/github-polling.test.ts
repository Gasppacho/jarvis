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

  it("re-reads a bounded recovery window and publishes a late event once", async () => {
    let now = new Date("2026-09-11T10:00:00.000Z");
    let cursor = {
      externalEventId: "200",
      eventTimestamp: "2026-09-11T10:00:00.000Z",
      updatedAt: "2026-09-11T10:00:00.000Z",
    };
    const pageOne = [
      labeledEvent("300", "2026-09-11T10:01:00.000Z", "already-seen"),
      labeledEvent("199", "2026-09-11T09:59:00.000Z", "late"),
      ...Array.from({ length: 98 }, (_, index) =>
        labeledEvent(
          String(400 + index),
          `2026-09-11T09:58:${String(index % 60).padStart(2, "0")}.000Z`,
          `seen-${index}`,
        ),
      ),
    ];
    const pageTwo = Array.from({ length: 100 }, (_, index) =>
      labeledEvent(
        String(500 + index),
        `2026-09-11T09:50:${String(index % 60).padStart(2, "0")}.000Z`,
        `old-${index}`,
      ),
    );
    const mapped = new Set([...pageOne, ...pageTwo].map((event) => String(event["id"])));
    mapped.delete("199");
    const calls: string[] = [];
    const published: string[] = [];
    let firstPoll!: () => void;
    let secondPoll!: () => void;
    const firstPollDone = new Promise<void>((resolve) => (firstPoll = resolve));
    const secondPollDone = new Promise<void>((resolve) => (secondPoll = resolve));
    const api: GitHubApi = {
      get: async (path) => {
        calls.push(path);
        if (calls.length === 2) firstPoll();
        if (calls.length === 4) secondPoll();
        return {
          status: 200,
          body: path.endsWith("page=1") ? pageOne : pageTwo,
        };
      },
      request: async () => ({ status: 200, body: [] }),
    };
    const scheduler = new GitHubPollingScheduler({
      projects: {
        list: () => [project],
        getResolvedProject: () => snapshot,
      },
      modules: { composition: () => composition },
      capabilities: {
        resolve: () => ({
          githubApi: api,
          pollCursor: {
            read: () => cursor,
            write: (input) => {
              cursor = { ...input, updatedAt: now.toISOString() };
            },
          },
          externalMappings: {
            read: (id) =>
              mapped.has(id) ? { status: "completed", resourceRef: "evt_existing" } : undefined,
            recordAttempt: () => undefined,
            recordResource: ({ idempotencyKey }) => mapped.add(idempotencyKey),
          },
        }),
      },
      publisher: {
        publish: (input) => {
          published.push(String(input.payload["tag"]));
          return { id: `evt_${published.length}` } as EventEnvelope;
        },
      },
      transaction: (operation) => operation(),
      ids: { next: () => "id" },
      clock: { now: () => now },
      pollIntervalMs: 1,
    });

    await scheduler.tick();
    await firstPollDone;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([
      "/repos/Gasppacho/jarvis/issues/events?per_page=100&page=1",
      "/repos/Gasppacho/jarvis/issues/events?per_page=100&page=2",
    ]);
    expect(published).toEqual(["late"]);

    now = new Date("2026-09-11T10:00:00.002Z");
    await scheduler.tick();
    await secondPollDone;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(4);
    expect(published).toEqual(["late"]);
  });
});

function labeledEvent(id: string, createdAt: string, tag: string): Record<string, unknown> {
  return {
    id,
    created_at: createdAt,
    event: "labeled",
    label: { name: tag },
    issue: { number: 42, title: "Recovery issue", state: "open" },
    actor: { login: "octocat" },
  };
}

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
    clock: { now: () => new Date() },
    pollIntervalMs,
  });
}
