import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../db/test-migrations.js";
import { ExecutionLedgerReader } from "./ledger.js";

/**
 * Ticket #59: `DeliveryConsumer` (executions/delivery-consumer.ts) only ever
 * writes `completed` or `failed` (its handler is synchronous and terminal in
 * one transaction), so the Application Harness can never produce a
 * `queued`/`running`/`cancelling`/`cancelled`/`timed_out` row to prove the
 * reader maps every state the schema allows — in particular the one whose
 * stored spelling (`timed_out`) differs from the contract's (`timed-out`).
 * This is exactly the "branch the harness cannot reach" case
 * (0007_inbox_execution_ledger.sql's CHECK constraint names all seven).
 */

let db: Database.Database | undefined;
afterEach(() => db?.close());

function seedDb(): Database.Database {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  db.prepare(
    `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
     VALUES ('proj-1', 'Proj', 'active', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO events (id, project_id, type, version, kind, envelope, occurred_at, recorded_at, correlation_id)
     VALUES ('evt_1', 'proj-1', 'sample.pinged', 1, 'fact', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'corr_1')`,
  ).run();
  return db;
}

const ALL_STATES: readonly { readonly stored: string; readonly api: string }[] = [
  { stored: "queued", api: "queued" },
  { stored: "running", api: "running" },
  { stored: "cancelling", api: "cancelling" },
  { stored: "completed", api: "completed" },
  { stored: "failed", api: "failed" },
  { stored: "cancelled", api: "cancelled" },
  // The one case the CHECK constraint and the OpenAPI contract spell differently.
  { stored: "timed_out", api: "timed-out" },
];

describe("ExecutionLedgerReader", () => {
  it("maps every stored Ledger status to the contract's spelling, including timed_out -> timed-out", () => {
    const database = seedDb();
    ALL_STATES.forEach(({ stored }, index) => {
      database
        .prepare(
          `INSERT INTO executions
             (id, project_id, module_instance_id, module_id, input_event_id, attempt, status, started_at, completed_at, created_at)
           VALUES
             (@id, 'proj-1', 'instance-1', 'module-1', 'evt_1', 1, @status, @createdAt, @createdAt, @createdAt)`,
        )
        .run({
          id: `exec_${stored}`,
          status: stored,
          // Distinct timestamps so ordering is unambiguous without a tie-break.
          createdAt: `2026-01-01T00:00:${String(10 + index).padStart(2, "0")}.000Z`,
        });
    });

    const reader = new ExecutionLedgerReader(database);
    const items = reader.list("proj-1", { limit: 100 });

    expect(items).toHaveLength(ALL_STATES.length);
    // Newest first: the last-inserted state (timed_out) has the latest
    // createdAt and leads.
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const { stored, api } of ALL_STATES) {
      expect(byId.get(`exec_${stored}`)).toMatchObject({ status: api, inputEventId: "evt_1" });
    }
    expect(items[0]!.id).toBe("exec_timed_out");
    expect(items[0]!.status).toBe("timed-out");
  });

  /**
   * Issue #59 code review, finding 1: `list()` had no `LIMIT`, so a Project
   * with a large Ledger made `better-sqlite3`'s synchronous `.all()` block the
   * engine's single thread on every call. `/v1/projects/{projectId}/executions`
   * now carries the same `limit` contract `/events` already has.
   */
  it("truncates the oldest end of the order with limit", () => {
    const database = seedDb();
    ["exec_1", "exec_2", "exec_3"].forEach((id, index) => {
      database
        .prepare(
          `INSERT INTO executions
             (id, project_id, module_instance_id, module_id, input_event_id, attempt, status, started_at, completed_at, created_at)
           VALUES
             (@id, 'proj-1', 'instance-1', 'module-1', 'evt_1', 1, 'completed', @createdAt, @createdAt, @createdAt)`,
        )
        .run({ id, createdAt: `2026-01-01T00:00:${String(10 + index).padStart(2, "0")}.000Z` });
    });

    const reader = new ExecutionLedgerReader(database);
    const items = reader.list("proj-1", { limit: 2 });

    expect(items.map((item) => item.id)).toEqual(["exec_3", "exec_2"]);
  });
});
