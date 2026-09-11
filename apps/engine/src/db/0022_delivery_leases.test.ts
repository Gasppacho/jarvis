import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "./test-migrations.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

describe("0022_delivery_leases", () => {
  it("adds an unclaimed lease to existing Deliveries", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, "0021");

    db.prepare(
      `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
       VALUES ('project-a', 'Project A', 'active', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO events
         (id, project_id, type, version, kind, envelope, occurred_at, recorded_at, correlation_id)
       VALUES ('event-a', 'project-a', 'sample.pinged', 1, 'fact', '{}',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'correlation-a')`,
    ).run();
    db.prepare(
      `INSERT INTO deliveries
         (id, project_id, event_id, module_instance_id, module_id, created_at)
       VALUES ('delivery-a', 'project-a', 'event-a', 'probe-1', 'sample.probe',
               '2026-01-01T00:00:00.000Z')`,
    ).run();

    applyMigration(db, "0022");

    expect(db.prepare("SELECT lease_owner, lease_expires_at FROM deliveries").get()).toEqual({
      lease_owner: null,
      lease_expires_at: null,
    });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'deliveries_claimable'",
        )
        .get(),
    ).toEqual({ name: "deliveries_claimable" });
  });
});
