import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../db/test-migrations.js";
import { EventJournalReader } from "./timeline.js";

/**
 * Ticket #59: the Application Harness runs the real engine against a real
 * wall clock, so it cannot force two Events to share an `occurredAt`
 * timestamp on demand — this is the "branch the harness cannot reach" case
 * for the ordering tie-break (issue #59 acceptance criteria: "stays stable
 * for two Events sharing an occurrence timestamp"). A direct SQLite fixture
 * can insert the tie deliberately.
 */

let db: Database.Database | undefined;
afterEach(() => db?.close());

function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    specVersion: "1.0",
    id: overrides["id"] ?? "evt_x",
    type: "sample.pinged",
    version: 1,
    kind: "fact",
    occurredAt: overrides["occurredAt"] ?? "2026-01-01T00:00:00.000Z",
    projectId: "proj-1",
    producer: { moduleId: "module-1", moduleInstanceId: "instance-1" },
    subject: { type: "work-item", ref: "work-item/1" },
    correlationId: overrides["correlationId"] ?? "corr_1",
    causationId: overrides["causationId"] ?? null,
    payload: {},
    ...overrides,
  });
}

function seedDb(): Database.Database {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  db.prepare(
    `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
     VALUES ('proj-1', 'Proj', 'active', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  return db;
}

function insertEvent(
  database: Database.Database,
  id: string,
  occurredAt: string,
  correlationId: string,
): void {
  database
    .prepare(
      `INSERT INTO events (id, project_id, type, version, kind, envelope, occurred_at, recorded_at, correlation_id)
       VALUES (@id, 'proj-1', 'sample.pinged', 1, 'fact', @envelope, @occurredAt, @occurredAt, @correlationId)`,
    )
    .run({
      id,
      envelope: envelope({ id, occurredAt, correlationId }),
      occurredAt,
      correlationId,
    });
}

describe("EventJournalReader", () => {
  it("tie-breaks two Events sharing an occurredAt by id descending, stably across calls", () => {
    const database = seedDb();
    const tie = "2026-01-01T00:00:00.000Z";
    // Inserted in ascending id order so a naive "insertion order" or
    // "rowid" tiebreak would pass by accident; only an explicit `id DESC`
    // in the query produces evt_b before evt_a.
    insertEvent(database, "evt_a", tie, "corr_1");
    insertEvent(database, "evt_b", tie, "corr_1");

    const reader = new EventJournalReader(database);
    const first = reader.list("proj-1", { limit: 10 });
    const second = reader.list("proj-1", { limit: 10 });

    expect(first.map((item) => item.id)).toEqual(["evt_b", "evt_a"]);
    // Same order on a second, independent call: the tiebreak is a property
    // of the query, not incidental storage order.
    expect(second.map((item) => item.id)).toEqual(["evt_b", "evt_a"]);
  });

  it("limit truncates the oldest end of the order", () => {
    const database = seedDb();
    insertEvent(database, "evt_1", "2026-01-01T00:00:01.000Z", "corr_1");
    insertEvent(database, "evt_2", "2026-01-01T00:00:02.000Z", "corr_1");
    insertEvent(database, "evt_3", "2026-01-01T00:00:03.000Z", "corr_1");

    const reader = new EventJournalReader(database);
    const items = reader.list("proj-1", { limit: 2 });

    expect(items.map((item) => item.id)).toEqual(["evt_3", "evt_2"]);
  });

  it("correlationIdsByEventId returns an empty map without querying for an empty input", () => {
    const database = seedDb();
    const reader = new EventJournalReader(database);
    expect(reader.correlationIdsByEventId("proj-1", [])).toEqual(new Map());
  });

  /**
   * Issue #59 code review, finding 3: `list()` filters on the `correlation_id`
   * column, but before this fix `toSummary` projected `envelope.correlationId`
   * from the JSON blob instead — two different sources that nothing kept in
   * sync. A row where they diverge proves which one the projection actually
   * reads: the column, so filtering and projecting can never disagree.
   */
  it("projects correlationId from the correlation_id column, not the envelope", () => {
    const database = seedDb();
    database
      .prepare(
        `INSERT INTO events (id, project_id, type, version, kind, envelope, occurred_at, recorded_at, correlation_id)
         VALUES ('evt_diverge', 'proj-1', 'sample.pinged', 1, 'fact', @envelope, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'corr_column')`,
      )
      .run({ envelope: envelope({ id: "evt_diverge", correlationId: "corr_envelope" }) });

    const reader = new EventJournalReader(database);
    const [item] = reader.list("proj-1", { limit: 10 });

    expect(item?.correlationId).toBe("corr_column");
  });

  /**
   * Issue #59 code review, finding 2: `correlation_id` had no `NOT NULL`, so a
   * NULL column value became `"correlationId": null` on the wire even though
   * the contract declares `correlationId: type: string`. Migration 0008 now
   * declares the column `NOT NULL DEFAULT ''`, which makes a NULL value
   * impossible to store in the first place rather than merely guarded against
   * at read time.
   */
  it("refuses to store a NULL correlation_id", () => {
    const database = seedDb();
    expect(() =>
      database
        .prepare(
          `INSERT INTO events (id, project_id, type, version, kind, envelope, occurred_at, recorded_at, correlation_id)
           VALUES ('evt_null', 'proj-1', 'sample.pinged', 1, 'fact', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)`,
        )
        .run(),
    ).toThrow(/NOT NULL constraint failed/);
  });
});
