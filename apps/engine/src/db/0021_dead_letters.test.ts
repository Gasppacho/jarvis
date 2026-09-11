import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "./test-migrations.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

describe("0021_dead_letters", () => {
  it("creates the project-scoped dead-letter table after retry state", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, "0020");
    applyMigration(db, "0021");

    const columns = db.prepare("PRAGMA table_info(dead_letters)").all() as {
      name: string;
      notnull: number;
    }[];
    expect(columns.map(({ name }) => name)).toEqual([
      "delivery_id",
      "project_id",
      "event_id",
      "module_instance_id",
      "code",
      "message",
      "attempts",
      "last_execution_id",
      "created_at",
    ]);
    expect(columns.every(({ notnull }) => notnull === 1)).toBe(true);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'dead_letters_project_id_created_at'",
        )
        .get(),
    ).toEqual({ name: "dead_letters_project_id_created_at" });
  });
});
