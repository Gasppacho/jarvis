import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "./test-migrations.js";

describe("0031 restores admission evidence after the shipped 0029 migration", () => {
  it.each([false, true])(
    "removes only unstarted ineligible admissions (checkpointed=%s)",
    (checkpointed) => {
      const db = new Database(":memory:");
      try {
        db.pragma("foreign_keys = ON");
        applyMigrations(db, "0030");
        db.exec(`
        INSERT INTO projects (id, name, status, portable_config, created_at, updated_at) VALUES ('a', 'A', 'active', '{}', '2026-09-12', '2026-09-12');
        INSERT INTO events (id, project_id, type, version, kind, envelope, occurred_at, recorded_at, correlation_id) VALUES ('request', 'a', 'development.implementation.requested', 1, 'request', '{}', '2026-09-12', '2026-09-12', 'corr');
        INSERT INTO deliveries (id, project_id, event_id, module_instance_id, module_id, created_at) VALUES ('delivery', 'a', 'request', 'development', 'jarvis.module.development', '2026-09-12');
        INSERT INTO development_admissions (delivery_id, project_id, status, reason, updated_at) VALUES ('delivery', 'a', 'ineligible', 'work-item-closed', '2026-09-12');
      `);
        if (checkpointed)
          db.exec(`
        INSERT INTO executions (id, project_id, module_instance_id, module_id, input_event_id, status, started_at, created_at) VALUES ('exec', 'a', 'development', 'jarvis.module.development', 'request', 'running', '2026-09-12', '2026-09-12');
        INSERT INTO execution_checkpoints (project_id, execution_id, sequence, source_sequence, type, payload, occurred_at) VALUES ('a', 'exec', 1, 1, 'agent.started', '{}', '2026-09-12');
      `);
        applyMigration(db, "0031");
        expect(db.prepare("SELECT consumed_at, attempt_count FROM deliveries").get()).toEqual({
          consumed_at: checkpointed ? null : "2026-09-12",
          attempt_count: 0,
        });
        expect(db.prepare("SELECT count(*) AS n FROM execution_checkpoints").get()).toEqual({
          n: checkpointed ? 1 : 0,
        });
        expect(db.prepare("SELECT status, reason FROM development_admissions").get()).toEqual({
          status: "ineligible",
          reason: "work-item-closed",
        });
      } finally {
        db.close();
      }
    },
  );

  it.each(["outbox", "events"])(
    "recovers the admitted duplicate from %s without admitting unrelated work",
    (table) => {
      const db = new Database(":memory:");
      try {
        applyMigrations(db, "0028");
        for (const project of ["a", "b"])
          db.prepare(
            "INSERT INTO projects (id, name, status, portable_config, created_at, updated_at) VALUES (?, ?, 'active', '{}', '2026-09-12', '2026-09-12')",
          ).run(project, project);
        const insert = db.prepare(`INSERT INTO github_work_item_readiness
        (project_id, module_instance_id, repository_id, work_item_ref, status, reason, blocker_refs, observed_at, admitted_at)
        VALUES (?, ?, 'main', 'github://owner/repo/issues/1', 'ready', 'ready', '[]', '2026-09-12', ?)`);
        insert.run("a", "first", null);
        insert.run("a", "second", "2026-09-12T01:00:00.000Z");
        insert.run("b", "first", null);
        const envelope = JSON.stringify({
          type: "scm.work-item.ready",
          occurredAt: "2026-09-12T01:00:00.000Z",
          payload: { repositoryId: "main", workItemRef: "github://owner/repo/issues/1" },
        });
        if (table === "outbox")
          db.prepare(
            "INSERT INTO outbox (event_id, project_id, envelope, status, created_at) VALUES ('ready', 'a', ?, 'pending', '2026-09-12')",
          ).run(envelope);
        else
          db.prepare(
            "INSERT INTO events (id, project_id, type, version, kind, envelope, occurred_at, recorded_at, correlation_id) VALUES ('ready', 'a', 'scm.work-item.ready', 1, 'fact', ?, '2026-09-12', '2026-09-12', 'corr')",
          ).run(envelope);
        applyMigration(db, "0029");
        applyMigration(db, "0030");
        expect(
          db
            .prepare("SELECT admitted_at FROM github_work_item_readiness WHERE project_id = 'a'")
            .get(),
        ).toEqual({ admitted_at: null });
        applyMigration(db, "0031");
        expect(
          db
            .prepare(
              "SELECT project_id, admitted_at FROM github_work_item_readiness ORDER BY project_id",
            )
            .all(),
        ).toEqual([
          { project_id: "a", admitted_at: "2026-09-12T01:00:00.000Z" },
          { project_id: "b", admitted_at: null },
        ]);
      } finally {
        db.close();
      }
    },
  );
});
