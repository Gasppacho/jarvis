import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "./test-migrations.js";

let db: Database.Database | undefined;

afterEach(() => db?.close());

describe("0018_external_mappings", () => {
  it("creates external_mappings on an empty database", () => {
    db = new Database(":memory:");

    applyMigrations(db);

    expectSchema(db);
  });

  it("upgrades a database created through 0017", () => {
    db = new Database(":memory:");

    applyMigrations(db, "0017");
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'external_mappings'").get(),
    ).toBeUndefined();

    applyMigration(db, "0018");

    expectSchema(db);
  });

  it("enforces the project/module/idempotency unique triple", () => {
    db = new Database(":memory:");

    applyMigrations(db);
    insertProject(db, "project-a");
    insertMapping(db, {
      projectId: "project-a",
      moduleInstanceId: "module-a",
      idempotencyKey: "request-1",
      status: "attempted",
      resourceRef: null,
    });
    insertMapping(db, {
      projectId: "project-a",
      moduleInstanceId: "module-a",
      idempotencyKey: "request-2",
      status: "attempted",
      resourceRef: null,
    });
    insertMapping(db, {
      projectId: "project-a",
      moduleInstanceId: "module-b",
      idempotencyKey: "request-1",
      status: "attempted",
      resourceRef: null,
    });

    expect(() =>
      insertMapping(db!, {
        projectId: "project-a",
        moduleInstanceId: "module-a",
        idempotencyKey: "request-1",
        status: "attempted",
        resourceRef: null,
      }),
    ).toThrow();
  });

  it("accepts only the valid attempted and completed resource states", () => {
    db = new Database(":memory:");

    applyMigrations(db);
    insertProject(db, "project-a");

    insertMapping(db, {
      projectId: "project-a",
      moduleInstanceId: "module-a",
      idempotencyKey: "attempted",
      status: "attempted",
      resourceRef: null,
    });
    insertMapping(db, {
      projectId: "project-a",
      moduleInstanceId: "module-a",
      idempotencyKey: "completed",
      status: "completed",
      resourceRef: "external://resource-1",
    });

    expect(() =>
      insertMapping(db!, {
        projectId: "project-a",
        moduleInstanceId: "module-a",
        idempotencyKey: "attempted-with-resource",
        status: "attempted",
        resourceRef: "external://resource-2",
      }),
    ).toThrow();
    expect(() =>
      insertMapping(db!, {
        projectId: "project-a",
        moduleInstanceId: "module-a",
        idempotencyKey: "completed-without-resource",
        status: "completed",
        resourceRef: null,
      }),
    ).toThrow();
  });

  it("cascades one project without deleting another project's mappings", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");

    applyMigrations(db);
    insertProject(db, "project-a");
    insertProject(db, "project-b");
    insertMapping(db, {
      projectId: "project-a",
      moduleInstanceId: "module-a",
      idempotencyKey: "request-a",
      status: "attempted",
      resourceRef: null,
    });
    insertMapping(db, {
      projectId: "project-b",
      moduleInstanceId: "module-b",
      idempotencyKey: "request-b",
      status: "completed",
      resourceRef: "external://resource-b",
    });

    db.prepare("DELETE FROM projects WHERE id = ?").run("project-a");

    expect(
      db
        .prepare("SELECT project_id, module_instance_id, idempotency_key FROM external_mappings")
        .all(),
    ).toEqual([
      {
        project_id: "project-b",
        module_instance_id: "module-b",
        idempotency_key: "request-b",
      },
    ]);
  });

  it("has no credential-shaped fields", () => {
    db = new Database(":memory:");

    applyMigrations(db);

    const columns = db.prepare("PRAGMA table_info(external_mappings)").all() as {
      name: string;
    }[];
    expect(columns.map((column) => column.name)).toEqual([
      "project_id",
      "module_instance_id",
      "idempotency_key",
      "status",
      "resource_ref",
      "created_at",
    ]);
    expect(
      columns
        .map((column) => column.name)
        .filter((name) => /secret|credential|token|password/i.test(name)),
    ).toEqual([]);
  });
});

function expectSchema(database: Database.Database): void {
  const table = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'external_mappings'")
    .get() as { sql: string } | undefined;
  expect(table?.sql).toContain("STRICT");

  const columns = database.prepare("PRAGMA table_info(external_mappings)").all() as {
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }[];
  expect(columns.map((column) => column.name)).toEqual([
    "project_id",
    "module_instance_id",
    "idempotency_key",
    "status",
    "resource_ref",
    "created_at",
  ]);
  expect(columns.map((column) => column.type)).toEqual([
    "TEXT",
    "TEXT",
    "TEXT",
    "TEXT",
    "TEXT",
    "TEXT",
  ]);
  expect(columns.map((column) => column.notnull)).toEqual([1, 1, 1, 1, 0, 1]);
  expect(columns.map((column) => column.pk)).toEqual([1, 2, 3, 0, 0, 0]);

  expect(database.prepare("PRAGMA foreign_key_list(external_mappings)").all()).toEqual([
    expect.objectContaining({
      table: "projects",
      from: "project_id",
      to: "id",
      on_delete: "CASCADE",
    }),
  ]);
}

function insertProject(database: Database.Database, id: string): void {
  database
    .prepare(
      `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
       VALUES (?, ?, 'active', '{}', ?, ?)`,
    )
    .run(id, id, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
}

function insertMapping(
  database: Database.Database,
  mapping: {
    projectId: string;
    moduleInstanceId: string;
    idempotencyKey: string;
    status: "attempted" | "completed";
    resourceRef: string | null;
  },
): void {
  database
    .prepare(
      `INSERT INTO external_mappings
       (project_id, module_instance_id, idempotency_key, status, resource_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      mapping.projectId,
      mapping.moduleInstanceId,
      mapping.idempotencyKey,
      mapping.status,
      mapping.resourceRef,
      "2026-01-01T00:00:00Z",
    );
}
