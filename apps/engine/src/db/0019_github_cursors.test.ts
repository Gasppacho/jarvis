import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "./test-migrations.js";

let db: Database.Database | undefined;

afterEach(() => db?.close());

describe("0019_github_cursors", () => {
  it("creates github_cursors on an empty database", () => {
    db = new Database(":memory:");

    applyMigrations(db);

    expectSchema(db);
  });

  it("upgrades a database created through 0018", () => {
    db = new Database(":memory:");

    applyMigrations(db, "0018");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'github_cursors'").get()).toBe(
      undefined,
    );

    applyMigration(db, "0019");

    expectSchema(db);
  });
});

function expectSchema(database: Database.Database): void {
  const table = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'github_cursors'")
    .get() as { sql: string } | undefined;
  expect(table?.sql).toContain("STRICT");

  const columns = database.prepare("PRAGMA table_info(github_cursors)").all() as {
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }[];
  expect(columns.map((column) => column.name)).toEqual([
    "project_id",
    "module_instance_id",
    "repository_id",
    "external_event_id",
    "event_timestamp",
    "updated_at",
  ]);
  expect(columns.map((column) => column.type)).toEqual([
    "TEXT",
    "TEXT",
    "TEXT",
    "TEXT",
    "TEXT",
    "TEXT",
  ]);
  expect(columns.map((column) => column.notnull)).toEqual([1, 1, 1, 1, 1, 1]);
  expect(columns.map((column) => column.pk)).toEqual([1, 2, 3, 0, 0, 0]);

  expect(database.prepare("PRAGMA foreign_key_list(github_cursors)").all()).toEqual([
    expect.objectContaining({
      table: "projects",
      from: "project_id",
      to: "id",
      on_delete: "CASCADE",
    }),
  ]);
}
