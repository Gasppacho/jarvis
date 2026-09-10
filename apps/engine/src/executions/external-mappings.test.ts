import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../db/test-migrations.js";
import { ControllableClock } from "../events/test-doubles.js";
import { ExternalMappingStore } from "./external-mappings.js";

let db: Database.Database | undefined;

afterEach(() => db?.close());

function openDb(): Database.Database {
  db = new Database(":memory:");
  applyMigrations(db);
  return db;
}

describe("ExternalMappingStore", () => {
  it("records attempts and completion transitions inside the caller transaction", () => {
    const database = openDb();
    const store = new ExternalMappingStore(
      database,
      new ControllableClock(new Date("2026-09-10T08:00:00.000Z")),
    );
    insertProject(database, "project-a");
    const mapping = store.bind("project-a", "module-a");

    database.transaction(() => {
      mapping.recordAttempt("request-1");
      mapping.recordAttempt("request-1");
      expect(mapping.read("request-1")).toEqual({
        status: "attempted",
        resourceRef: undefined,
      });

      mapping.recordResource({ idempotencyKey: "request-1", resourceRef: "resource-1" });
      mapping.recordResource({ idempotencyKey: "request-1", resourceRef: "resource-2" });
    })();

    expect(mapping.read("request-1")).toEqual({
      status: "completed",
      resourceRef: "resource-1",
    });

    mapping.recordAttempt("request-1");
    expect(mapping.read("request-1")).toEqual({
      status: "completed",
      resourceRef: "resource-1",
    });
  });

  it("creates a completed mapping when no attempt exists and isolates project/module scope", () => {
    const database = openDb();
    const store = new ExternalMappingStore(
      database,
      new ControllableClock(new Date("2026-09-10T08:00:00.000Z")),
    );
    insertProject(database, "project-a");
    insertProject(database, "project-b");
    const mapping = store.bind("project-a", "module-a");
    const otherMapping = store.bind("project-b", "module-a");
    const otherInstance = store.bind("project-a", "module-b");

    mapping.recordResource({ idempotencyKey: "request-1", resourceRef: "resource-1" });

    expect(mapping.read("request-1")).toEqual({
      status: "completed",
      resourceRef: "resource-1",
    });
    expect(otherMapping.read("request-1")).toBeUndefined();
    expect(otherInstance.read("request-1")).toBeUndefined();
    expect(mapping.read("missing")).toBeUndefined();

    database.transaction(() => mapping.flushPending?.())();
    expect(
      database
        .prepare(
          `SELECT status, resource_ref FROM external_mappings
           WHERE project_id = 'project-a' AND module_instance_id = 'module-a'`,
        )
        .get(),
    ).toEqual({ status: "completed", resource_ref: "resource-1" });
  });
});

function insertProject(database: Database.Database, id: string): void {
  database
    .prepare(
      `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
       VALUES (?, ?, 'active', '{}', ?, ?)`,
    )
    .run(id, id, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
}
