import { describe, expect, it } from "vitest";
import { FakeRuntime } from "../../../../packages/agent-runtime/src/index.js";
import { GitHubApiClient } from "../../../../packages/modules/github/src/index.js";
import { EngineError } from "../errors.js";
import { LocalAgentRuntimeRegistry } from "../projects/resource-grants.js";
import type { ResolvedProjectSnapshot } from "../projects/store.js";
import { ProjectModuleCapabilityResolver } from "./capabilities.js";

const moduleComposition = {
  composition(moduleId: string) {
    return moduleId === "agent-module"
      ? { requires: [{ id: "agent.execute", binding: "agentRuntime" as const }] }
      : moduleId === "project-commands-module"
        ? {
            requires: [
              {
                id: "shell.execute",
                optional: true,
                resolution: { kind: "engine" as const, ref: "engine/local" },
              },
            ],
          }
        : moduleId === "github-module"
          ? { requires: [{ id: "github.api", binding: "sourceControl" as const }] }
          : { requires: [] };
  },
};

type SnapshotConfiguration = Pick<ResolvedProjectSnapshot["composition"], "commands" | "git">;

function snapshot(
  runtimeRef?: string,
  composition: SnapshotConfiguration = {} as SnapshotConfiguration,
): ResolvedProjectSnapshot {
  return {
    composition: composition as ResolvedProjectSnapshot["composition"],
    moduleInstances: [
      {
        instanceId: "development",
        moduleId: "agent-module",
        enabled: true,
        runtimeSlot: "agentRuntime",
      },
    ],
    bindings: {
      slots: runtimeRef === undefined ? {} : { agentRuntime: { kind: "runtime", ref: runtimeRef } },
      repository: { path: "/tmp/project", bookmarkRef: null },
    },
    requestRoutes: [],
  };
}

describe("ProjectModuleCapabilityResolver", () => {
  it("resolves project commands and Git policy from the addressed Project snapshot only", () => {
    const snapshots = new Map([
      [
        "project-a",
        snapshot("runtime/fake-test", {
          commands: { test: "pnpm test" },
          git: {
            branchPattern: "agent/{workItemId}",
            commitStrategy: "conventional",
            pushRemote: "origin",
            allowForcePush: false,
          },
        }),
      ],
      [
        "project-b",
        snapshot("runtime/fake-test", {
          commands: { test: "npm test" },
          git: {
            branchPattern: "work/{slug}",
            commitStrategy: "ticket-prefix",
            pushRemote: "upstream",
            allowForcePush: false,
          },
        }),
      ],
    ]);
    const resolver = new ProjectModuleCapabilityResolver(
      { getResolvedProject: (projectId) => snapshots.get(projectId) },
      moduleComposition,
      new LocalAgentRuntimeRegistry(),
    );

    expect(resolver.resolve("project-a", "development", "project-commands-module")).toMatchObject({
      projectCommands: {
        commands: { test: "pnpm test" },
        git: {
          branchPattern: "agent/{workItemId}",
          commitStrategy: "conventional",
          pushRemote: "origin",
          allowForcePush: false,
        },
      },
    });
    expect(
      resolver.resolve("project-b", "development", "project-commands-module").projectCommands
        ?.commands,
    ).toEqual({ test: "npm test" });
  });

  it("leaves project commands unavailable before Project activation", () => {
    const resolver = new ProjectModuleCapabilityResolver(
      { getResolvedProject: () => undefined },
      moduleComposition,
      new LocalAgentRuntimeRegistry(),
    );

    expect(
      resolver.resolve("project-a", "development", "project-commands-module").projectCommands,
    ).toBeUndefined();
  });

  it("resolves only the runtime bound by the addressed Project", () => {
    const snapshots = new Map([
      ["project-a", snapshot("runtime/fake-test")],
      ["project-b", snapshot("runtime/unknown")],
    ]);
    const resolver = new ProjectModuleCapabilityResolver(
      { getResolvedProject: (projectId) => snapshots.get(projectId) },
      moduleComposition,
      new LocalAgentRuntimeRegistry(),
    );

    expect(
      resolver.resolve("project-a", "development", "agent-module").agentRuntime,
    ).toBeInstanceOf(FakeRuntime);
    expect(() => resolver.resolve("project-b", "development", "agent-module")).toThrow(
      "Project project-b cannot resolve agent.execute",
    );
  });

  it("does not expose a runtime to modules that did not declare agent.execute", () => {
    const resolver = new ProjectModuleCapabilityResolver(
      { getResolvedProject: () => snapshot("runtime/fake-test") },
      moduleComposition,
      new LocalAgentRuntimeRegistry(),
    );

    expect(resolver.resolve("project-a", "development", "unprivileged-module")).toEqual({});
  });

  it("returns a typed configuration error when the required slot is unbound", () => {
    const resolver = new ProjectModuleCapabilityResolver(
      { getResolvedProject: () => snapshot() },
      moduleComposition,
      new LocalAgentRuntimeRegistry(),
    );

    try {
      resolver.resolve("project-a", "development", "agent-module");
      throw new Error("expected capability resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(EngineError);
      expect(error).toMatchObject({
        code: "project.capability-unresolved",
        details: { projectId: "project-a", slot: "agentRuntime" },
      });
    }
  });

  it("resolves only the bound available GitHub connection into github.api", () => {
    const snapshots = new Map([
      [
        "project-a",
        {
          ...snapshot(),
          moduleInstances: [{ instanceId: "github", moduleId: "github-module", enabled: true }],
          bindings: {
            ...snapshot().bindings,
            slots: { sourceControl: { kind: "connection" as const, ref: "connection/a" } },
          },
        },
      ],
      [
        "project-b",
        {
          ...snapshot(),
          moduleInstances: [{ instanceId: "github", moduleId: "github-module", enabled: true }],
          bindings: {
            ...snapshot().bindings,
            slots: { sourceControl: { kind: "connection" as const, ref: "connection/b" } },
          },
        },
      ],
    ]);
    const connections = new Map([
      ["connection/a", connection("connection/a", "Account A")],
      ["connection/b", connection("connection/b", "Account B")],
    ]);
    const resolver = new ProjectModuleCapabilityResolver(
      { getResolvedProject: (projectId) => snapshots.get(projectId) },
      moduleComposition,
      new LocalAgentRuntimeRegistry(),
      undefined,
      { find: (id) => connections.get(id) },
      { resolve: async () => ({ status: "available", credential: "not-retained" }) },
      "http://127.0.0.1:1234",
    );

    const projectA = resolver.resolve("project-a", "github", "github-module");
    const projectB = resolver.resolve("project-b", "github", "github-module");
    expect(projectA.githubApi).toBeInstanceOf(GitHubApiClient);
    expect(projectB.githubApi).toBeInstanceOf(GitHubApiClient);
    expect(projectA.projectBindings?.slots).toEqual({
      sourceControl: { kind: "connection", ref: "connection/a" },
    });
    expect(projectB.projectBindings?.slots).toEqual({
      sourceControl: { kind: "connection", ref: "connection/b" },
    });
  });

  it.each([
    ["unbound", {}, "has no Local Binding"],
    [
      "wrong kind",
      { sourceControl: { kind: "runtime", ref: "runtime/fake-test" } },
      "not a connection",
    ],
    [
      "unavailable",
      { sourceControl: { kind: "connection", ref: "connection/a" } },
      "is unauthenticated",
    ],
  ] as const)("rejects a GitHub binding that is %s", (_label, slots, reason) => {
    const project = {
      ...snapshot(),
      moduleInstances: [{ instanceId: "github", moduleId: "github-module", enabled: true }],
      bindings: { ...snapshot().bindings, slots },
    };
    const resolver = new ProjectModuleCapabilityResolver(
      { getResolvedProject: () => project },
      moduleComposition,
      new LocalAgentRuntimeRegistry(),
      undefined,
      { find: () => connection("connection/a", "Account A", "unauthenticated") },
      { resolve: async () => ({ status: "available", credential: "not-retained" }) },
    );

    expect(() => resolver.resolve("project-a", "github", "github-module")).toThrow(reason);
  });
});

function connection(
  id: string,
  accountLabel: string,
  status: "available" | "unauthenticated" = "available",
) {
  return {
    id,
    provider: "github",
    accountLabel,
    capabilities: ["github.api", "scm.change-request.manage", "work-items.read"],
    status,
    secretRef: `gh://${accountLabel}`,
  };
}
