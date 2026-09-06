import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { EventEnvelopeContractRegistry } from "../../../../packages/eventing/src/envelope.js";
import { applyMigrations } from "../db/test-migrations.js";
import { EngineError } from "../errors.js";
import { EventPublisher } from "./publisher.js";
import { ControllableClock, DeterministicIdGenerator } from "./test-doubles.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const schema = JSON.parse(
  readFileSync(`${ROOT}/contracts/schemas/event-envelope.v1.schema.json`, "utf8"),
) as object;

const PROJECT_ID = "token-warehouse";

let db: Database.Database | undefined;
afterEach(() => db?.close());

function openDb(): Database.Database {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  // Stands in for the Module state a real publication mutates in the same
  // transaction; Module-owned tables arrive with #57.
  db.exec(`CREATE TABLE module_state (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`);
  db.prepare(
    `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
     VALUES (@id, @id, 'active', '{}', @at, @at)`,
  ).run({ id: PROJECT_ID, at: "2026-08-28T08:00:00.000Z" });
  return db;
}

function factInput(overrides: Record<string, unknown> = {}) {
  return {
    type: "scm.work-item.tag-added",
    version: 1,
    kind: "fact" as const,
    projectId: PROJECT_ID,
    producer: { moduleId: "jarvis.module.github", moduleInstanceId: "github" },
    subject: { type: "work-item", ref: "github://QServices/token-warehouse/issues/42" },
    correlationId: "corr_01K0000000000000000000",
    causationId: null,
    payload: {},
    ...overrides,
  };
}

describe("EventPublisher", () => {
  it("writes state and the Outbox row atomically within the caller's transaction", () => {
    const database = openDb();
    const clock = new ControllableClock(new Date("2026-08-28T08:00:00.000Z"));
    const ids = new DeterministicIdGenerator();
    const publisher = new EventPublisher(
      database,
      clock,
      ids,
      new EventEnvelopeContractRegistry({ eventEnvelopeV1: schema }),
    );

    const envelope = database.transaction(() => {
      database.prepare("INSERT INTO module_state (id, value) VALUES ('m1', 'ready')").run();
      return publisher.publish(factInput());
    })();

    expect(envelope.id).toBe("evt_test000001");
    expect(envelope.occurredAt).toBe("2026-08-28T08:00:00.000Z");
    const row = database.prepare("SELECT * FROM outbox WHERE event_id = ?").get(envelope.id) as
      { project_id: string; status: string } | undefined;
    expect(row).toMatchObject({ project_id: PROJECT_ID, status: "pending" });
    expect(database.prepare("SELECT 1 FROM module_state WHERE id = 'm1'").get()).toBeDefined();
  });

  it("rejects an envelope that violates the v1 contract with event.envelope-invalid, and leaves neither state nor Outbox row written", () => {
    const database = openDb();
    const publisher = new EventPublisher(
      database,
      new ControllableClock(new Date("2026-08-28T08:00:00.000Z")),
      new DeterministicIdGenerator(),
      new EventEnvelopeContractRegistry({ eventEnvelopeV1: schema }),
    );

    // A request declares no target/idempotencyKey: the envelope schema's
    // conditional `allOf` rejects it.
    let error: unknown;
    try {
      database.transaction(() => {
        database.prepare("INSERT INTO module_state (id, value) VALUES ('m1', 'ready')").run();
        publisher.publish(factInput({ kind: "request" }));
      })();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe("event.envelope-invalid");

    expect(database.prepare("SELECT 1 FROM module_state WHERE id = 'm1'").get()).toBeUndefined();
    expect(database.prepare("SELECT 1 FROM outbox").get()).toBeUndefined();
  });

  it("ignores a caller-supplied id and occurredAt, taking both from the injected ports", () => {
    const database = openDb();
    const publisher = new EventPublisher(
      database,
      new ControllableClock(new Date("2026-08-28T08:00:00.000Z")),
      new DeterministicIdGenerator(),
      new EventEnvelopeContractRegistry({ eventEnvelopeV1: schema }),
    );

    const envelope = publisher.publish(
      factInput({ id: "evt_forged", occurredAt: "1999-01-01T00:00:00.000Z" }),
    );

    expect(envelope.id).toBe("evt_test000001");
    expect(envelope.occurredAt).toBe("2026-08-28T08:00:00.000Z");
  });

  it("assigns a fresh event id and occurredAt from the injected ports on every call", () => {
    const database = openDb();
    const clock = new ControllableClock(new Date("2026-08-28T08:00:00.000Z"));
    const publisher = new EventPublisher(
      database,
      clock,
      new DeterministicIdGenerator(),
      new EventEnvelopeContractRegistry({ eventEnvelopeV1: schema }),
    );

    const first = publisher.publish(factInput());
    clock.advance(1_000);
    const second = publisher.publish(factInput());

    expect(first.id).not.toBe(second.id);
    expect(second.occurredAt).toBe("2026-08-28T08:00:01.000Z");
  });
});
