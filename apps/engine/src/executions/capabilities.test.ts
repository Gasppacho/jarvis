import { describe, expect, it } from "vitest";
import {
  FakeRuntime,
  type RuntimeDescriptor,
} from "../../../../packages/agent-runtime/src/index.js";
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
          : moduleId === "jarvis.module.development"
            ? { requires: [{ id: "github.api", binding: "sourceControl" as const }] }
            : { requires: [] };
  },
};

function snapshot(runtimeRef?: string): ResolvedProjectSnapshot {
  return {
    composition: {
      apiVersion: "jarvis.dev/project/v1",
      kind: "Project",
      metadata: { id: "project", name: "Project" },
      repositories: [{ id: "main", root: "." }],
      slots: {},
      modules: [],
    },
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
  it("resolves push credentials only for the bound Project GitHub repository", async () => {
    const base = snapshot();
    const projectSnapshot: ResolvedProjectSnapshot = {
      ...base,
      repositoryIdentities: [
        { repositoryId: "main", provider: "github", owner: "Gasppacho", name: "jarvis-test" },
      ],
      moduleInstances: [
        {
          instanceId: "development",
          moduleId: "jarvis.module.development",
          enabled: true,
          bindings: { sourceControl: "sourceControl" },
        },
        {
          instanceId: "github",
          moduleId: "jarvis.module.github",
          enabled: true,
          bindings: { sourceControl: "sourceControl" },
        },
      ],
      bindings: {
        ...base.bindings,
        slots: { sourceControl: { kind: "connection", ref: "connection/github" } },
      },
    };
    const resolver = new ProjectModuleCapabilityResolver(
      { getResolvedProject: () => projectSnapshot },
      moduleComposition,
      new LocalAgentRuntimeRegistry(),
      undefined,
      {
        find: () => ({
          id: "connection/github",
          provider: "github",
          accountLabel: "Gasppacho",
          capabilities: ["github.api", "scm.change-request.manage", "work-items.read"],
          status: "available",
          secretRef: "gh://Gasppacho",
        }),
      },
      { resolve: async () => ({ status: "available", credential: "fixture-token" }) },
    );

    const capability = resolver.resolve("project", "development", "jarvis.module.development");

    await expect(
      capability.gitPushCredentials?.resolve(
        "main",
        "https://github.com/Gasppacho/jarvis-test.git",
      ),
    ).resolves.toEqual({
      username: "x-access-token",
      password: "fixture-token",
      remoteUrl: "https://github.com/Gasppacho/jarvis-test.git",
    });
    await expect(
      capability.gitPushCredentials?.resolve("main", "https://github.com/Gasppacho/other.git"),
    ).resolves.toBeUndefined();
  });

  it("resolves the engine shell without exposing project execution policy", () => {
    const snapshots = new Map([["project-a", snapshot("runtime/fake-test")]]);
    const resolver = new ProjectModuleCapabilityResolver(
      { getResolvedProject: (projectId) => snapshots.get(projectId) },
      moduleComposition,
      new LocalAgentRuntimeRegistry(),
    );

    const capabilities = resolver.resolve("project-a", "development", "project-commands-module");
    expect(capabilities.shell).toBeDefined();
    expect(capabilities).not.toHaveProperty("projectCommands");
  });

  it("leaves the shell unavailable before Project activation", () => {
    const resolver = new ProjectModuleCapabilityResolver(
      { getResolvedProject: () => undefined },
      moduleComposition,
      new LocalAgentRuntimeRegistry(),
    );

    expect(
      resolver.resolve("project-a", "development", "project-commands-module").shell,
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

  it("refuses a runtime grant that is rebound after capability resolution", () => {
    const snapshots = new Map([["project-a", snapshot("runtime/fake-test")]]);
    const resolver = new ProjectModuleCapabilityResolver(
      { getResolvedProject: (projectId) => snapshots.get(projectId) },
      moduleComposition,
      new LocalAgentRuntimeRegistry(),
    );
    const capabilities = resolver.resolve("project-a", "development", "agent-module");
    snapshots.set("project-a", snapshot("runtime/unknown"));

    expect(capabilities.revalidateAgentRuntime?.()).toBeUndefined();
  });

  it("uses the current local runtime profile when it revalidates an unchanged grant", () => {
    const initial = {
      ...snapshot("runtime/fake-test"),
      bindings: {
        ...snapshot("runtime/fake-test").bindings,
        slots: {
          agentRuntime: {
            kind: "runtime" as const,
            ref: "runtime/fake-test",
            environment: { PATH: "/old/profile" },
          },
        },
      },
    };
    const snapshots = new Map([["project-a", initial]]);
    const resolver = new ProjectModuleCapabilityResolver(
      { getResolvedProject: (projectId) => snapshots.get(projectId) },
      moduleComposition,
      new LocalAgentRuntimeRegistry(),
    );
    const capabilities = resolver.resolve("project-a", "development", "agent-module");
    const current = {
      ...snapshot("runtime/fake-test"),
      bindings: {
        ...snapshot("runtime/fake-test").bindings,
        slots: {
          agentRuntime: {
            kind: "runtime" as const,
            ref: "runtime/fake-test",
            environment: { PATH: "/new/profile" },
          },
        },
      },
    };
    snapshots.set("project-a", current);

    expect(capabilities.revalidateAgentRuntime?.()).toMatchObject({
      projectBindings: {
        slots: {
          agentRuntime: {
            kind: "runtime",
            ref: "runtime/fake-test",
            environment: { PATH: "/new/profile" },
          },
        },
      },
    });
  });

  it("refuses a descriptor whose executable path changes after allocation", () => {
    let descriptor: RuntimeDescriptor = {
      id: "runtime/codex-default",
      provider: "codex",
      displayName: "Codex",
      executablePath: "/approved/codex",
      version: "0.153.4",
      capabilities: ["agent.execute"],
      status: "available",
    };
    const resolver = new ProjectModuleCapabilityResolver(
      { getResolvedProject: () => snapshot("runtime/codex-default") },
      moduleComposition,
      new LocalAgentRuntimeRegistry({ list: () => [descriptor] }),
    );
    const capabilities = resolver.resolve("project-a", "development", "agent-module");
    descriptor = { ...descriptor, executablePath: "/changed/codex" };

    expect(capabilities.revalidateAgentRuntime?.()).toBeUndefined();
  });

  it("refuses a descriptor whose granted capabilities change after allocation", () => {
    let descriptor: RuntimeDescriptor = {
      id: "runtime/codex-default",
      provider: "codex",
      displayName: "Codex",
      executablePath: "/approved/codex",
      version: "0.153.4",
      capabilities: ["agent.execute"],
      status: "available",
    };
    const resolver = new ProjectModuleCapabilityResolver(
      { getResolvedProject: () => snapshot("runtime/codex-default") },
      moduleComposition,
      new LocalAgentRuntimeRegistry({ list: () => [descriptor] }),
    );
    const capabilities = resolver.resolve("project-a", "development", "agent-module");
    descriptor = { ...descriptor, capabilities: [] };

    expect(capabilities.revalidateAgentRuntime?.()).toBeUndefined();
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
