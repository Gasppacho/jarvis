import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "../src/db/test-migrations.js";
import { openDatabase } from "../src/db/open.js";

let db: Database.Database | undefined;

afterEach(() => db?.close());

describe("execution checkpoint migration", () => {
  it("backs up and preserves a 0032 validation failure before recording new outcomes", () => {
    const root = mkdtempSync("/tmp/jarvis-outcomes-migration-");
    const path = join(root, "jarvis.sqlite");
    try {
      db = new Database(path);
      db.pragma("foreign_keys = ON");
      applyMigrations(db, "0032");
      db.exec(
        "CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT",
      );
      for (const file of readdirSync(
        fileURLToPath(new URL("../src/db/migrations/", import.meta.url)),
      ).filter((name) => name.endsWith(".sql") && name.slice(0, 4) <= "0032")) {
        db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(
          file.slice(0, -4),
          "2026-09-13T00:00:00.000Z",
        );
      }
      db.exec(`
        INSERT INTO projects (id, name, status, portable_config, created_at, updated_at) VALUES ('project', 'Project', 'draft', '{}', 't0', 't0');
        INSERT INTO events (id, project_id, type, version, kind, envelope, occurred_at, recorded_at, correlation_id) VALUES ('event', 'project', 'sample.pinged', 1, 'fact', '{}', 't0', 't0', 'correlation');
        INSERT INTO executions (id, project_id, module_instance_id, module_id, input_event_id, status, started_at, created_at) VALUES ('execution', 'project', 'development', 'jarvis.module.development', 'event', 'failed', 't0', 't0');
        INSERT INTO execution_checkpoints VALUES ('project', 'execution', 1, 1, 'validation.failed', '{"check":"test","output":"historical failure"}', 't1');
      `);
      const before = db.prepare("SELECT * FROM execution_checkpoints").all();
      db.close();
      db = openDatabase(path).db;
      expect(db.prepare("SELECT * FROM execution_checkpoints").all()).toEqual(before);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      const backups = readdirSync(root).filter(
        (name) => name.includes(".pre-0033_validation_outcomes-") && name.endsWith(".bak"),
      );
      expect(backups).toHaveLength(1);
      expect(statSync(join(root, backups[0]!)).mode & 0o777).toBe(0o600);
      const backup = new Database(join(root, backups[0]!), { readonly: true });
      try {
        expect(backup.prepare("SELECT * FROM execution_checkpoints").all()).toEqual(before);
      } finally {
        backup.close();
      }
    } finally {
      db?.close();
      db = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates the durable checkpoint schema from empty and the previous snapshot", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db);
    expectSchema(db);

    db.close();
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, "0010");
    applyMigration(db, "0011");
    expectSchema(db);
    applyMigration(db, "0012");
    applyMigration(db, "0013");
    expectSchema(db);
    applyMigration(db, "0014");
    expectSchema(db);
    applyMigration(db, "0015");
    expectSchema(db);
    db.close();
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, "0025");
    applyMigration(db, "0026");
    expectSchema(db);
    expect(
      (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'execution_checkpoints'",
          )
          .get() as { sql: string }
      ).sql,
    ).toContain("preparation.completed");
    const inbox = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inbox'")
      .get() as { sql: string } | undefined;
    expect(inbox?.sql).toContain("'timed_out'");
  });
});

function expectSchema(database: Database.Database): void {
  const table = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'execution_checkpoints'",
    )
    .get() as { sql: string } | undefined;
  expect(table?.sql).toContain("execution_checkpoints");
  expect(table?.sql).toContain("STRICT");

  const columns = database.prepare("PRAGMA table_info(execution_checkpoints)").all() as {
    name: string;
    notnull: number;
  }[];
  expect(columns.map((column) => column.name)).toEqual([
    "project_id",
    "execution_id",
    "sequence",
    "source_sequence",
    "type",
    "payload",
    "occurred_at",
  ]);
  expect(columns.every((column) => column.notnull)).toBe(true);

  const indexes = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'execution_checkpoints'",
    )
    .all() as { name: string }[];
  expect(indexes.map((index) => index.name)).toEqual(
    expect.arrayContaining(["execution_checkpoints_agent_started_once"]),
  );
}
