import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../db/test-migrations.js";
import { ExecutionCheckpointStore } from "./checkpoints.js";

let db: Database.Database | undefined;

afterEach(() => db?.close());

describe("ExecutionCheckpointStore", () => {
  it("keeps agent checkpoints ordered and scoped even when timestamps tie", () => {
    db = seedDatabase();
    const store = new ExecutionCheckpointStore(db);
    const occurredAt = "2026-09-08T21:00:00.000Z";

    store.record({
      projectId: "project-a",
      executionId: "execution-a",
      type: "agent.started",
      sourceSequence: 1,
      occurredAt,
    });
    store.record({
      projectId: "project-a",
      executionId: "execution-a",
      type: "agent.message",
      sourceSequence: 2,
      occurredAt,
      message: "first",
    });
    store.record({
      projectId: "project-a",
      executionId: "execution-a",
      type: "agent.message",
      sourceSequence: 3,
      occurredAt,
      message: "second",
    });

    expect(store.list("project-a", "execution-a")).toEqual([
      expect.objectContaining({
        sequence: 1,
        type: "agent.started",
        occurredAt,
        payload: {},
      }),
      expect.objectContaining({
        sequence: 2,
        type: "agent.message",
        occurredAt,
        payload: { message: "first" },
      }),
      expect.objectContaining({
        sequence: 3,
        type: "agent.message",
        occurredAt,
        payload: { message: "second" },
      }),
    ]);
    expect(store.list("project-b", "execution-a")).toEqual([]);
    expect(() =>
      store.record({
        projectId: "project-b",
        executionId: "execution-a",
        type: "agent.message",
        sourceSequence: 1,
        occurredAt,
        message: "cross-project",
      }),
    ).toThrow("does not belong to Project project-b");
  });

  it("deduplicates a repeated runtime sequence without creating another checkpoint", () => {
    db = seedDatabase();
    const store = new ExecutionCheckpointStore(db);
    const input = {
      projectId: "project-a",
      executionId: "execution-a",
      type: "agent.message" as const,
      sourceSequence: 2,
      occurredAt: "2026-09-08T21:00:00.000Z",
      message: "one message",
    };

    const first = store.record(input);
    const repeated = store.record({ ...input, message: "duplicate should be ignored" });

    expect(repeated).toEqual(first);
    expect(store.list("project-a", "execution-a")).toHaveLength(1);
  });

  it("redacts secrets and personal absolute paths before persistence", () => {
    db = seedDatabase();
    const store = new ExecutionCheckpointStore(db);

    store.record({
      projectId: "project-a",
      executionId: "execution-a",
      type: "agent.message",
      sourceSequence: 1,
      occurredAt: "2026-09-08T21:00:00.000Z",
      message: "token=super-secret cwd=/Users/quentin/private/repo",
    });

    expect(store.list("project-a", "execution-a")[0]?.payload).toEqual({
      message: "token=<redacted> cwd=<path>",
    });
  });

  it("records preparation progress durably for recovery", () => {
    db = seedDatabase();
    const store = new ExecutionCheckpointStore(db);
    const base = {
      projectId: "project-a",
      executionId: "execution-a",
      occurredAt: "2026-09-08T21:00:00.000Z",
    };
    store.record({ ...base, type: "preparation.started", sourceSequence: 1 });
    store.record({ ...base, type: "preparation.completed", sourceSequence: 2 });

    expect(store.has("project-a", "execution-a", "preparation.completed")).toBe(true);
    expect(store.lastSourceSequence("project-a", "execution-a")).toBe(2);
  });
});

function seedDatabase(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  applyMigrations(database);
  for (const projectId of ["project-a", "project-b"]) {
    database
      .prepare(
        `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
         VALUES (@id, @id, 'active', '{}', '2026-09-08T20:00:00.000Z', '2026-09-08T20:00:00.000Z')`,
      )
      .run({ id: projectId });
  }
  database
    .prepare(
      `INSERT INTO events
         (id, project_id, type, version, kind, envelope, occurred_at, recorded_at, correlation_id)
       VALUES (@id, @projectId, 'sample.pinged', 1, 'fact', '{}',
               '2026-09-08T20:00:00.000Z', '2026-09-08T20:00:00.000Z', @correlationId)`,
    )
    .run({ id: "event-a", projectId: "project-a", correlationId: "correlation-a" });
  database
    .prepare(
      `INSERT INTO executions
         (id, project_id, module_instance_id, module_id, input_event_id, status, started_at, created_at)
       VALUES ('execution-a', 'project-a', 'development', 'jarvis.module.development', 'event-a',
               'running', '2026-09-08T20:00:00.000Z', '2026-09-08T20:00:00.000Z')`,
    )
    .run();
  return database;
}
