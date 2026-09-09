import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { RuntimeDescriptor } from "../../../../packages/agent-runtime/src/index.js";
import { applyMigrations } from "../db/test-migrations.js";
import { RuntimeRegistry } from "../runtimes/registry.js";
import { LocalAgentRuntimeRegistry } from "./resource-grants.js";

const descriptor = (status: RuntimeDescriptor["status"]): RuntimeDescriptor => ({
  id: "runtime/codex-default",
  provider: "codex",
  displayName: "Codex — default",
  executablePath: "/tmp/codex",
  version: "0.153.4",
  capabilities: ["agent.execute"],
  status,
});

describe("LocalAgentRuntimeRegistry", () => {
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
    db.prepare(
      `UPDATE runtime_descriptors SET status = ?, executable_path = ? WHERE id = ?`,
    ).run("unauthenticated", "/private/secret/codex", "runtime/fake-test");
    const details = registry.grantedResourceDetails("project-a");
    expect(details).toContainEqual({
      candidate: expect.objectContaining({ ref: "runtime/fake-test" }),
      status: "unauthenticated",
    });
    expect(registry.grantedToProject("project-a")).toEqual([]);
    db.close();
  });
});
