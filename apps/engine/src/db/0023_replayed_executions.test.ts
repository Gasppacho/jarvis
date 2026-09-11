import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "./test-migrations.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

describe("0023_replayed_executions", () => {
  it("adds an audit bit that defaults to an automatic Execution", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, "0022");
    applyMigration(db, "0023");

    expect(
      db
        .prepare("PRAGMA table_info(executions)")
        .all()
        .find((column) => (column as { name: string }).name === "replayed"),
    ).toMatchObject({ name: "replayed", notnull: 1, dflt_value: "0" });
  });
});
