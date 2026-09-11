import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "./test-migrations.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

describe("0024_nullable_dead_letter_execution", () => {
  it("allows a dead letter without an execution when execution recording itself failed", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, "0023");
    applyMigration(db, "0024");

    const column = db
      .prepare("PRAGMA table_info(dead_letters)")
      .all()
      .find((value) => (value as { name: string }).name === "last_execution_id") as
      { notnull: number } | undefined;
    expect(column).toMatchObject({ notnull: 0 });
  });
});
