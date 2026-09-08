import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "../src/db/test-migrations.js";

let db: Database.Database | undefined;

afterEach(() => db?.close());

describe("execution checkpoint migration", () => {
  it("creates the durable checkpoint schema from empty and the previous snapshot", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db);
    expectSchema(db);

    db.close();
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, "0010");
    applyMigration(db, "0011");
    expectSchema(db);
  });
});

function expectSchema(database: Database.Database): void {
  const table = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'execution_checkpoints'",
    )
    .get() as { sql: string } | undefined;
  expect(table?.sql).toContain("CREATE TABLE execution_checkpoints");
  expect(table?.sql).toContain("STRICT");

  const columns = database.prepare("PRAGMA table_info(execution_checkpoints)").all() as {
    name: string;
    notnull: number;
  }[];
  expect(columns.map((column) => column.name)).toEqual([
    "project_id",
    "execution_id",
    "sequence",
    "source_sequence",
    "type",
    "payload",
    "occurred_at",
  ]);
  expect(columns.every((column) => column.notnull)).toBe(true);

  const indexes = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'execution_checkpoints'",
    )
    .all() as { name: string }[];
  expect(indexes.map((index) => index.name)).toEqual(
    expect.arrayContaining([
      "execution_checkpoints_project_execution_sequence",
      "execution_checkpoints_agent_started_once",
    ]),
  );
}
