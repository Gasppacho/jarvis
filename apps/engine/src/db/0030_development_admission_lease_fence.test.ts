import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./test-migrations.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

describe("0030_development_admission_lease_fence", () => {
  it("atomically rejects a workspace lease after the Project is suspended", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db);
    db.exec(`
      INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
      VALUES ('project-a', 'Project A', 'active', '{}', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
      INSERT INTO development_admission_controls (project_id, suspended_at, updated_at)
      VALUES ('project-a', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
    `);

    expect(() =>
      db!
        .prepare(
          `INSERT INTO workspace_leases
         (id, project_id, execution_id, repository_id, working_branch, base_revision_sha,
          workspace_path, status, expires_at, cleanup_policy, created_at, updated_at, owner_pid)
         VALUES ('lease-a', 'project-a', 'execution-a', 'main', 'agent/a', '1234567890123456789012345678901234567890',
          '/tmp/project-a', 'active', '9999-12-31T23:59:59.999Z', 'delete-on-failure',
          '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z', 1)`,
        )
        .run(),
    ).toThrow("development-admission-suspended");
  });
});
