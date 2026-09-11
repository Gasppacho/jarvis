import { afterEach, describe, expect, it } from "vitest";
import { LocalAgentRuntimeRegistry } from "../src/projects/resource-grants.js";
import { ProjectModuleCapabilityResolver } from "../src/executions/capabilities.js";
import type { ResolvedProjectSnapshot } from "../src/projects/store.js";
import { startFakeGitHubApi, type FakeGitHubApi } from "./harness.js";

const servers: FakeGitHubApi[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("project-bound Work Items capability", () => {
  it("reads a canonical Issue only through the bound tickets connection", async () => {
    const fakeGitHub = await startFakeGitHubApi();
    servers.push(fakeGitHub);
    fakeGitHub.seedIssue({
      owner: "Gasppacho",
      repository: "jarvis",
      issue: {
        number: 16,
        title: "Reference workflow",
        body: "External issue text",
        state: "open",
        labels: [{ name: "agent:ready" }],
      },
    });

    const snapshots = new Map([
      ["project-a", snapshot("project-a", "connection/a")],
      ["project-b", snapshot("project-b")],
    ]);
    const resolver = resolverFor(snapshots, fakeGitHub.baseUrl);
    const capabilities = resolver.resolve("project-a", "reader", "work-items-reader");

    await expect(
      capabilities.workItems?.read("github://Gasppacho/jarvis/issues/16"),
    ).resolves.toEqual({
      ref: "github://Gasppacho/jarvis/issues/16",
      number: 16,
      title: "Reference workflow",
      body: "External issue text",
      state: "open",
    });
    expect(fakeGitHub.requests).toContainEqual({
      method: "GET",
      path: "/repos/Gasppacho/jarvis/issues/16",
      credential: "token-a",
    });
    expect(capabilities.workItems).toBeDefined();
    expect(resolver.resolve("project-b", "reader", "work-items-reader").workItems).toBeUndefined();
    expect(resolver.resolve("project-a", "reader", "unprivileged")).toEqual({});
  });

  it("does not expose provider credentials and classifies API failures", async () => {
    const fakeGitHub = await startFakeGitHubApi();
    servers.push(fakeGitHub);
    const resolver = resolverFor(
      new Map([["project-a", snapshot("project-a", "connection/a")]]),
      fakeGitHub.baseUrl,
    );
    const workItems = resolver.resolve("project-a", "reader", "work-items-reader").workItems!;
    const ref = "github://Gasppacho/jarvis/issues/16";

    await expect(workItems.read("fixture://not-github"))
      .rejects.toMatchObject({ code: "github.change-request-invalid", retryable: false });

    const restoreUnauthorized = fakeGitHub.scriptRoute("GET", "/repos/Gasppacho/jarvis/issues/16", {
      status: 401,
      body: { message: "token-a" },
    });
    await expect(workItems.read(ref)).rejects.toMatchObject({
      code: "github.work-item-unauthorized",
      retryable: true,
    });
    restoreUnauthorized();

    const restoreUnavailable = fakeGitHub.scriptRoute("GET", "/repos/Gasppacho/jarvis/issues/16", {
      status: 503,
      body: { message: "token-a" },
    });
    await expect(workItems.read(ref)).rejects.toMatchObject({
      code: "github.work-item-unavailable",
      retryable: true,
    });
    restoreUnavailable();
    expect(JSON.stringify(workItems)).not.toContain("token-a");
  });
});

function resolverFor(
  snapshots: ReadonlyMap<string, ResolvedProjectSnapshot>,
  apiBaseUrl: string,
): ProjectModuleCapabilityResolver {
  return new ProjectModuleCapabilityResolver(
    { getResolvedProject: (projectId) => snapshots.get(projectId) },
    {
      composition: (moduleId) =>
        moduleId === "work-items-reader"
          ? {
              requires: [
                { id: "work-items.read", binding: "tickets", optional: true },
              ],
            }
          : { requires: [] },
    },
    new LocalAgentRuntimeRegistry(),
    undefined,
    { find: (id) => connection(id) },
    {
      resolve: async (secretRef) => ({
        status: "available",
        credential: secretRef.endsWith("/a") ? "token-a" : "token-b",
      }),
    },
    apiBaseUrl,
  );
}

function snapshot(projectId: string, connectionRef?: string): ResolvedProjectSnapshot {
  return {
    composition: {
      commands: {},
      git: {
        branchPattern: "agent/{workItemId}",
        commitStrategy: "conventional",
        pushRemote: "origin",
        allowForcePush: false,
      },
    } as ResolvedProjectSnapshot["composition"],
    moduleInstances: [{ instanceId: "reader", moduleId: "work-items-reader", enabled: true }],
    bindings: {
      repository: { path: "/tmp/project", bookmarkRef: null },
      slots: connectionRef === undefined ? {} : { tickets: { kind: "connection", ref: connectionRef } },
    },
    requestRoutes: [],
  };
}

function connection(id: string) {
  return {
    id,
    provider: "github",
    accountLabel: id,
    capabilities: ["work-items.read"],
    status: "available" as const,
    secretRef: `gh://${id.replace("connection/", "")}`,
  };
}
