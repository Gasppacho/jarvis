import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "./test-migrations.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

describe("0027_github_work_item_readiness", () => {
  it("adds one project-scoped durable readiness admission table", () => {
    db = new Database(":memory:");
    applyMigrations(db, "0026");
    applyMigration(db, "0027");
    const columns = db.prepare("PRAGMA table_info(github_work_item_readiness)").all() as {
      readonly name: string;
    }[];
    expect(columns.map(({ name }) => name)).toEqual([
      "project_id",
      "module_instance_id",
      "repository_id",
      "work_item_ref",
      "status",
      "reason",
      "blocker_refs",
      "observed_at",
      "admitted_at",
    ]);
    expect(db.prepare("PRAGMA foreign_key_list(github_work_item_readiness)").all()).toEqual([
      expect.objectContaining({ table: "projects", from: "project_id", on_delete: "CASCADE" }),
    ]);
  });
});
