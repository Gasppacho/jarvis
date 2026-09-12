import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "./test-migrations.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

describe("0029_github_work_item_readiness_project_identity", () => {
  it("keeps one readiness admission when two GitHub instances observe one work item", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, "0028");
    db.prepare(
      `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
       VALUES ('project-a', 'Project A', 'active', '{}', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z')`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO github_work_item_readiness
       (project_id, module_instance_id, repository_id, work_item_ref, status, reason, blocker_refs, observed_at)
       VALUES ('project-a', ?, 'main', 'github://owner/repo/issues/1', 'ready', 'ready', '[]', '2026-09-12T00:00:00.000Z')`,
    );
    insert.run("github-a");
    insert.run("github-b");

    applyMigration(db, "0029");

    expect(db.prepare("SELECT module_instance_id FROM github_work_item_readiness").all()).toEqual([
      { module_instance_id: "github-a" },
    ]);
    expect(() => insert.run("github-c")).toThrow();
  });
});
