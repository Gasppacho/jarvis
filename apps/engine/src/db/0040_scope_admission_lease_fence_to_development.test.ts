import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./test-migrations.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

describe("0040_scope_admission_lease_fence_to_development", () => {
  it("fences Development workspace leases without blocking Pull Request", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db);
    db.exec(`
      INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
      VALUES ('project-a', 'Project A', 'active', '{}', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
      INSERT INTO development_admission_controls (project_id, suspended_at, updated_at)
      VALUES ('project-a', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
      INSERT INTO events (id, project_id, type, version, kind, envelope, occurred_at, recorded_at)
      VALUES
        ('event-development', 'project-a', 'development.implementation.requested', 1, 'request', '{}', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'),
        ('event-pull-request', 'project-a', 'development.implementation.completed', 1, 'fact', '{}', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
      INSERT INTO executions (id, project_id, module_instance_id, module_id, input_event_id, status, started_at, created_at)
      VALUES
        ('execution-development', 'project-a', 'development', 'jarvis.module.development', 'event-development', 'running', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'),
        ('execution-pull-request', 'project-a', 'pull-request', 'jarvis.module.pull-request', 'event-pull-request', 'running', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
    `);

    const createLease = db.prepare(
      `INSERT INTO workspace_leases
       (id, project_id, execution_id, repository_id, working_branch, base_revision_sha,
        workspace_path, status, expires_at, cleanup_policy, created_at, updated_at, owner_pid)
       VALUES (?, 'project-a', ?, 'main', ?, '1234567890123456789012345678901234567890',
        ?, 'active', '9999-12-31T23:59:59.999Z', 'delete-on-failure',
        '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z', 1)`,
    );

    expect(() =>
      createLease.run(
        "lease-development",
        "execution-development",
        "agent/development",
        "/tmp/project-a/development",
      ),
    ).toThrow("development-admission-suspended");
    expect(() =>
      createLease.run(
        "lease-pull-request",
        "execution-pull-request",
        "agent/pull-request",
        "/tmp/project-a/pull-request",
      ),
    ).not.toThrow();
  });
});
