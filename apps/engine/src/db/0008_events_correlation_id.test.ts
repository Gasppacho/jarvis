import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "./test-migrations.js";

/**
 * Issue #59 code review, finding 6: every other test applies the whole
 * migration chain to an empty database, so 0008's backfill —
 * `UPDATE events SET correlation_id = json_extract(envelope, '$.correlationId')
 * WHERE correlation_id = ''` — only ever ran against zero rows. A typo in
 * that JSON path would ship silently and surface only on a real user's
 * upgrade. This test applies 0001-0007, inserts a row the way a pre-#59
 * database already holds one (no `correlation_id` column exists yet), then
 * applies 0008 on top and asserts the column was actually populated from the
 * envelope already on disk.
 */

let db: Database.Database | undefined;
afterEach(() => db?.close());

describe("0008_events_correlation_id backfill", () => {
  it("populates correlation_id from the envelope already on disk for a pre-existing row", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, "0007");

    db.prepare(
      `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
       VALUES ('proj-1', 'Proj', 'active', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    const envelope = JSON.stringify({
      specVersion: "1.0",
      id: "evt_existing",
      type: "sample.pinged",
      version: 1,
      kind: "fact",
      occurredAt: "2026-01-01T00:00:00.000Z",
      projectId: "proj-1",
      producer: { moduleId: "module-1", moduleInstanceId: "instance-1" },
      subject: { type: "work-item", ref: "work-item/1" },
      correlationId: "corr_pre_existing",
      causationId: null,
      payload: {},
    });
    // No `correlation_id` column yet: this is exactly the row shape an
    // upgrading database has before 0008 runs.
    db.prepare(
      `INSERT INTO events (id, project_id, type, version, kind, envelope, occurred_at, recorded_at)
       VALUES ('evt_existing', 'proj-1', 'sample.pinged', 1, 'fact', @envelope, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run({ envelope });

    applyMigration(db, "0008");

    const row = db.prepare(`SELECT correlation_id FROM events WHERE id = 'evt_existing'`).get() as {
      correlation_id: string;
    };
    expect(row.correlation_id).toBe("corr_pre_existing");
  });
});
