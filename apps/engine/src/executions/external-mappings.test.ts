import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ControllableClock } from "../events/test-doubles.js";
import { ExternalMappingStore } from "./external-mappings.js";

let db: Database.Database | undefined;

afterEach(() => db?.close());

function openDb(): Database.Database {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE external_mappings (
      project_id TEXT NOT NULL,
      module_instance_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('attempted', 'completed')),
      resource_ref TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, module_instance_id, idempotency_key),
      CHECK (
        (status = 'attempted' AND resource_ref IS NULL) OR
        (status = 'completed' AND resource_ref IS NOT NULL)
      )
    ) STRICT
  `);
  return db;
}

describe("ExternalMappingStore", () => {
  it("records attempts and completion transitions inside the caller transaction", () => {
    const database = openDb();
    const store = new ExternalMappingStore(
      database,
      new ControllableClock(new Date("2026-09-10T08:00:00.000Z")),
    );
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
    const mapping = store.bind("project-a", "module-a");
    const otherMapping = store.bind("project-b", "module-a");

    mapping.recordResource({ idempotencyKey: "request-1", resourceRef: "resource-1" });

    expect(mapping.read("request-1")).toEqual({
      status: "completed",
      resourceRef: "resource-1",
    });
    expect(otherMapping.read("request-1")).toBeUndefined();
    expect(mapping.read("missing")).toBeUndefined();
  });
});
