import { describe, expect, it } from "vitest";
import { FakeRuntime } from "../../../../packages/agent-runtime/src/index.js";
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
});
