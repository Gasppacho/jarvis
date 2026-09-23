import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "./test-migrations.js";

describe("0037 local project drafts", () => {
  it("resets idle projects but preserves a project with an active execution", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      applyMigrations(db, "0036");
      db.prepare(
        `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
         VALUES ('project', 'Project', 'active', ?, '2026-09-19', '2026-09-19')`,
      ).run(
        JSON.stringify({
          apiVersion: "jarvis.dev/project/v1",
          kind: "Project",
          metadata: { id: "project", name: "Project" },
          compositionMode: "fixed-modules",
          repositories: [{ id: "main", root: "." }],
          slots: { agentRuntime: { requires: "agent-runtime.invoke" } },
          modules: [{ instanceId: "development", moduleId: "jarvis.module.development" }],
          git: {},
          workspace: {},
          commands: {},
        }),
      );
      db.prepare(
        `INSERT INTO project_bindings
           (project_id, repository_path, bookmark_ref, slot_bindings)
         VALUES ('project', '/tmp/project', 'bookmark/project/main', '{"agentRuntime":{"kind":"agent-runtime","ref":"codex"}}')`,
      ).run();
      db.prepare(
        `INSERT INTO project_resolved_compositions
           (project_id, composition_fingerprint, resolved_project, activated_at)
         VALUES ('project', 'fingerprint', '{}', '2026-09-19')`,
      ).run();

      db.prepare(
        `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
         VALUES ('busy', 'Busy', 'active', ?, '2026-09-19', '2026-09-19')`,
      ).run(
        JSON.stringify({
          apiVersion: "jarvis.dev/project/v1",
          kind: "Project",
          metadata: { id: "busy", name: "Busy" },
          compositionMode: "fixed-modules",
          repositories: [{ id: "main", root: "." }],
          slots: { agentRuntime: { requires: "agent-runtime.invoke" } },
          modules: [{ instanceId: "development", moduleId: "jarvis.module.development" }],
          git: {},
          workspace: {},
          commands: {},
        }),
      );
      db.prepare(
        `INSERT INTO project_bindings
           (project_id, repository_path, bookmark_ref, slot_bindings)
         VALUES ('busy', '/tmp/busy', 'bookmark/busy/main', '{"agentRuntime":{"kind":"agent-runtime","ref":"codex"}}')`,
      ).run();
      db.prepare(
        `INSERT INTO project_resolved_compositions
           (project_id, composition_fingerprint, resolved_project, activated_at)
         VALUES ('busy', 'busy-fingerprint', '{"kept":true}', '2026-09-19')`,
      ).run();
      db.prepare(
        `INSERT INTO events
           (id, project_id, type, version, kind, envelope, occurred_at, recorded_at)
         VALUES ('busy-event', 'busy', 'work.requested', 1, 'request', '{}', '2026-09-19', '2026-09-19')`,
      ).run();
      db.prepare(
        `INSERT INTO executions
           (id, project_id, module_instance_id, module_id, input_event_id, status, started_at, created_at)
         VALUES ('busy-execution', 'busy', 'development', 'jarvis.module.development', 'busy-event', 'running', '2026-09-19', '2026-09-19')`,
      ).run();

      const busyBefore = db.prepare("SELECT * FROM projects WHERE id = 'busy'").get();
      const busyBindingsBefore = db
        .prepare("SELECT * FROM project_bindings WHERE project_id = 'busy'")
        .get();
      const busyResolvedBefore = db
        .prepare("SELECT * FROM project_resolved_compositions WHERE project_id = 'busy'")
        .get();

      applyMigration(db, "0037");

      const project = db
        .prepare("SELECT status, portable_config FROM projects WHERE id = 'project'")
        .get() as { status: string; portable_config: string };
      expect(project.status).toBe("draft");
      expect(JSON.parse(project.portable_config)).toMatchObject({
        compositionMode: "fixed-modules",
        modules: [],
        slots: {},
      });
      expect(
        db.prepare("SELECT * FROM project_bindings WHERE project_id = 'project'").get(),
      ).toMatchObject({
        repository_path: "/tmp/project",
        bookmark_ref: "bookmark/project/main",
        slot_bindings: "{}",
      });
      expect(
        db
          .prepare("SELECT 1 FROM project_resolved_compositions WHERE project_id = 'project'")
          .get(),
      ).toBeUndefined();
      expect(db.prepare("SELECT * FROM projects WHERE id = 'busy'").get()).toEqual(busyBefore);
      expect(db.prepare("SELECT * FROM project_bindings WHERE project_id = 'busy'").get()).toEqual(
        busyBindingsBefore,
      );
      expect(
        db.prepare("SELECT * FROM project_resolved_compositions WHERE project_id = 'busy'").get(),
      ).toEqual(busyResolvedBefore);
    } finally {
      db.close();
    }
  });
});
