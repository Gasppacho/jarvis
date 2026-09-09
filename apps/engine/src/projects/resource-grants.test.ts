import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CodexRuntime } from "../../../../packages/agent-runtime/src/codex-runtime.js";
import {
  FakeRuntime,
  type RuntimeDescriptor,
} from "../../../../packages/agent-runtime/src/index.js";
import { applyMigrations } from "../db/test-migrations.js";
import { RuntimeRegistry } from "../runtimes/registry.js";
import { LocalAgentRuntimeRegistry } from "./resource-grants.js";

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
