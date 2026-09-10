import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CodexRuntime } from "../../../../packages/agent-runtime/src/codex-runtime.js";
import {
  FakeRuntime,
  type RuntimeDescriptor,
} from "../../../../packages/agent-runtime/src/index.js";
import { applyMigrations } from "../db/test-migrations.js";
import { RuntimeRegistry } from "../runtimes/registry.js";
import {
  ConnectionGrantSource,
  LocalAgentRuntimeRegistry,
  ProjectResourceGrantAggregate,
  type ProjectResourceGrant,
  type ProjectResourceGrantDetailsPort,
} from "./resource-grants.js";

const descriptor = (
  status: RuntimeDescriptor["status"],
  id = "runtime/codex-default",
  executablePath = "/tmp/codex",
): RuntimeDescriptor => ({
  id,
  provider: "codex",
  displayName: "Codex — default",
  executablePath,
  version: "0.153.4",
  capabilities: ["agent.execute"],
  status,
});

describe("LocalAgentRuntimeRegistry", () => {
  it("resolves only available persisted Codex descriptors with absolute paths", () => {
    const registry = new LocalAgentRuntimeRegistry({
      list: () => [
        descriptor("available"),
        descriptor("unavailable", "runtime/codex-unavailable"),
        descriptor("available", "runtime/codex-relative", "codex"),
      ],
    });

    expect(registry.resolve("project-a", "runtime/codex-default")).toBeInstanceOf(CodexRuntime);
    expect(registry.resolve("project-a", "runtime/codex-unavailable")).toBeUndefined();
    expect(registry.resolve("project-a", "runtime/codex-relative")).toBeUndefined();
    expect(registry.resolve("project-a", "runtime/unknown")).toBeUndefined();
    expect(registry.resolve("project-a", "runtime/fake-test")).toBeInstanceOf(FakeRuntime);
  });

  it("projects available descriptors and keeps unavailable status metadata private", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const runtimeRegistry = new RuntimeRegistry(db, {
      detector: { detect: async () => null },
    });
    const registry = new LocalAgentRuntimeRegistry(runtimeRegistry);

    expect(registry.grantedToProject("project-a")).toEqual([
      expect.objectContaining({ ref: "runtime/fake-test", displayName: "Fake Runtime" }),
    ]);

    runtimeRegistry.list();
    db.prepare(`UPDATE runtime_descriptors SET status = ?, executable_path = ? WHERE id = ?`).run(
      "unauthenticated",
      "/private/secret/codex",
      "runtime/fake-test",
    );
    const details = registry.grantedResourceDetails("project-a");
    expect(details).toContainEqual({
      candidate: expect.objectContaining({ ref: "runtime/fake-test" }),
      status: "unauthenticated",
    });
    expect(registry.grantedToProject("project-a")).toEqual([]);
    db.close();
  });
});

const grant = (ref: string, status: RuntimeDescriptor["status"] = "available") => ({
  candidate: {
    ref,
    kind: "runtime" as const,
    displayName: ref,
    capabilities: ["agent.execute"],
  },
  status,
});

const source = (grants: readonly ProjectResourceGrant[]): ProjectResourceGrantDetailsPort => ({
  grantedResourceDetails: () => grants,
});

describe("ProjectResourceGrantAggregate", () => {
  it("merges source details unchanged while filtering unavailable candidates", () => {
    const unavailable = grant("runtime/unavailable", "unavailable");
    const available = grant("runtime/available");
    const aggregate = new ProjectResourceGrantAggregate([
      source([unavailable]),
      source([available]),
    ]);

    expect(aggregate.grantedResourceDetails("project-a")).toEqual([available, unavailable]);
    expect(aggregate.grantedResourceDetails("project-a")[0]).toBe(available);
    expect(aggregate.grantedToProject("project-a")).toEqual([available.candidate]);
  });

  it("sorts independently of source registration and insertion order", () => {
    const first = grant("runtime/first");
    const second = grant("runtime/second");
    const third = grant("runtime/third");
    const forward = new ProjectResourceGrantAggregate([source([third, first]), source([second])]);
    const reverse = new ProjectResourceGrantAggregate([source([second]), source([first, third])]);

    expect(forward.grantedResourceDetails("project-a")).toEqual([first, second, third]);
    expect(reverse.grantedResourceDetails("project-a")).toEqual([first, second, third]);
  });

  it("returns nothing without sources and fails on duplicate resource claims", () => {
    const duplicate = grant("runtime/duplicate");
    expect(new ProjectResourceGrantAggregate().grantedToProject("project-a")).toEqual([]);

    expect(() =>
      new ProjectResourceGrantAggregate([
        source([duplicate]),
        source([duplicate]),
      ]).grantedToProject("project-a"),
    ).toThrowError(
      expect.objectContaining({
        name: "EngineError",
        code: "system.internal-error",
        message: expect.stringContaining("resource grant conflict"),
      }),
    );
  });
});

describe("ConnectionGrantSource", () => {
  it("maps descriptors to project candidates without exposing secret references", () => {
    const source = new ConnectionGrantSource({
      list: () => [
        {
          id: "connection/github",
          provider: "github",
          accountLabel: "Gasppacho",
          capabilities: ["github.api", "scm.change-request.manage"],
          status: "available",
          secretRef: "gh://Gasppacho",
        },
        {
          id: "connection/revoked",
          provider: "github",
          accountLabel: "Revoked",
          capabilities: ["github.api"],
          status: "revoked",
          secretRef: "gh://revoked",
        },
      ],
    });

    expect(source.grantedResourceDetails("project-a")).toEqual([
      {
        candidate: {
          ref: "connection/github",
          kind: "connection",
          displayName: "Gasppacho",
          capabilities: ["github.api", "scm.change-request.manage"],
        },
        status: "available",
      },
      {
        candidate: {
          ref: "connection/revoked",
          kind: "connection",
          displayName: "Revoked",
          capabilities: ["github.api"],
        },
        status: "revoked",
      },
    ]);
    expect(JSON.stringify(source.grantedResourceDetails("project-a"))).not.toContain("gh://");
  });

  it("exposes available connections through the grant port only", () => {
    const source = new ConnectionGrantSource({
      list: () => [
        {
          id: "connection/available",
          provider: "github",
          accountLabel: "Available",
          capabilities: ["github.api"],
          status: "available",
          secretRef: "gh://available",
        },
        {
          id: "connection/unavailable",
          provider: "github",
          accountLabel: "Unavailable",
          capabilities: ["github.api"],
          status: "unavailable",
          secretRef: "gh://unavailable",
        },
      ],
    });
    const aggregate = new ProjectResourceGrantAggregate([source]);

    expect(aggregate.grantedToProject("project-a")).toEqual([
      {
        ref: "connection/available",
        kind: "connection",
        displayName: "Available",
        capabilities: ["github.api"],
      },
    ]);
  });
});
