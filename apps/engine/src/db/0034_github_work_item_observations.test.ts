import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "./test-migrations.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

describe("0034_github_work_item_observations", () => {
  it("adds one project and repository scoped snapshot table", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, "0033");
    applyMigration(db, "0034");

    expect(db.prepare("PRAGMA table_info(github_work_item_observations)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "observation_revision" }),
        expect.objectContaining({ name: "verification" }),
        expect.objectContaining({ name: "reason_code" }),
      ]),
    );
    expect(db.prepare("PRAGMA index_list(github_work_item_observations)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "sqlite_autoindex_github_work_item_observations_1" }),
      ]),
    );
  });
});
