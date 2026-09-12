import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "./test-migrations.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

describe("0032_project_overview", () => {
  it("adds renderable readiness metadata and durable polling health", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, "0031");
    applyMigration(db, "0032");

    const columns = db.prepare("PRAGMA table_info(github_work_item_readiness)").all() as {
      readonly name: string;
    }[];
    expect(columns.map(({ name }) => name)).toContainEqual("issue_number");
    expect(columns.map(({ name }) => name)).toContainEqual("title");
    expect(columns.map(({ name }) => name)).toContainEqual("tag");
    expect(columns.map(({ name }) => name)).toContainEqual("rule_matches");
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'github_polling_status'").get(),
    ).toEqual({
      name: "github_polling_status",
    });
  });
});
