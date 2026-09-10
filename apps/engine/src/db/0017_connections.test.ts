import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "./test-migrations.js";

let db: Database.Database | undefined;

afterEach(() => db?.close());

describe("0017_connections", () => {
  it("creates the connections table on an empty database", () => {
    db = new Database(":memory:");

    applyMigrations(db);

    expectSchema(db);
  });

  it("upgrades a database created before the connection descriptor ticket", () => {
    db = new Database(":memory:");

    applyMigrations(db, "0016");
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'connections'").get(),
    ).toBeUndefined();

    applyMigration(db, "0017");

    expectSchema(db);
  });
});

function expectSchema(database: Database.Database): void {
  const table = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connections'")
    .get() as { sql: string } | undefined;
  expect(table?.sql).toContain("STRICT");

  const columns = database.prepare("PRAGMA table_info(connections)").all() as { name: string }[];
  expect(columns.map((column) => column.name)).toEqual([
    "id",
    "provider",
    "account_label",
    "capabilities",
    "status",
    "secret_ref",
  ]);
}
