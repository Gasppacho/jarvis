import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Clock } from "../../../../packages/kernel/src/clock.js";
import { EventEnvelopeContractRegistry } from "../../../../packages/eventing/src/envelope.js";
import { deriveProjectSubscriptions } from "../../../../packages/project-runtime/src/project-subscriptions.js";
import type {
  ProjectModuleInstanceConfiguration,
  StoredPortableProjectConfiguration,
} from "../../../../packages/project-runtime/src/project-types.js";
import { applyMigrations } from "../db/test-migrations.js";
import { EngineError } from "../errors.js";
import { ProjectStore, type ResolvedProjectSnapshot } from "../projects/store.js";
import { OutboxDispatcher, type OpenSubscriptionsPort } from "./dispatcher.js";
import { EventPublisher } from "./publisher.js";
import { ControllableClock, DeterministicIdGenerator } from "./test-doubles.js";

/**
 * Ticket #56's highest realistic seam: no Module exists yet to trigger a
 * publish over HTTP (that lands with #57/#58), so this exercises the real
 * pipeline — real SQLite, the real `ProjectStore`/`deriveProjectSubscriptions`
 * a Module would activate through, and the real `EventPublisher` +
 * `OutboxDispatcher` — end to end in one process, no mocks. "Restart-free"
 * per the ticket's test seam: one open connection throughout.
 */

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const envelopeSchema = JSON.parse(
  readFileSync(`${ROOT}/contracts/schemas/event-envelope.v1.schema.json`, "utf8"),
) as object;

let db: Database.Database | undefined;
afterEach(() => db?.close());

function openDb(clock: Clock): { db: Database.Database; store: ProjectStore } {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  return { db, store: new ProjectStore(db, clock) };
}

function draftConfig(id: string): StoredPortableProjectConfiguration {
  return {
    apiVersion: "jarvis.dev/project/v1",
    kind: "Project",
    metadata: { id, name: id },
    repositories: [{ id: "main", root: ".", defaultBranch: "main", remote: "origin" }],
    slots: {},
    commands: {},
    git: {
      branchPattern: "agent/{workItemId}-{slug}",
      commitStrategy: "conventional",
      pushRemote: "origin",
      allowForcePush: false,
    },
    workspace: { strategy: "git-worktree", maxConcurrentExecutions: 1, retainOnFailureDays: 7 },
    modules: [],
  };
}

/** Manifest metadata `deriveProjectSubscriptions` needs — a plain lookup, no ModuleHost. */
const TAG_ADDED = { type: "scm.work-item.tag-added", version: 1, kind: "fact" as const };
const COMPOSITIONS: Record<string, { consumes: readonly (typeof TAG_ADDED)[] }> = {
  "jarvis.module.automation-rules": { consumes: [TAG_ADDED] },
};

function activate(
  store: ProjectStore,
  projectId: string,
  instances: readonly ProjectModuleInstanceConfiguration[],
): void {
  store.createProject({
    id: projectId,
    name: projectId,
    status: "draft",
    portableConfig: draftConfig(projectId),
    repositoryPath: `/tmp/${projectId}`,
  });
  const snapshot: ResolvedProjectSnapshot = {
    composition: draftConfig(projectId),
    moduleInstances: instances,
    bindings: { slots: {}, repository: { path: `/tmp/${projectId}`, bookmarkRef: null } },
    requestRoutes: [],
  };
  store.activateProject(projectId, "fingerprint-1", snapshot);
}

function openSubscriptionsPort(store: ProjectStore): OpenSubscriptionsPort {
  return (projectId) =>
    deriveProjectSubscriptions(
      projectId,
      store.getResolvedProject(projectId)?.moduleInstances ?? [],
      { composition: (moduleId) => COMPOSITIONS[moduleId] },
    ).items;
}

function factInput(projectId: string, overrides: Record<string, unknown> = {}) {
  return {
    type: TAG_ADDED.type,
    version: TAG_ADDED.version,
    kind: TAG_ADDED.kind,
    projectId,
    producer: { moduleId: "jarvis.module.github", moduleInstanceId: "github" },
    subject: { type: "work-item", ref: `github://acme/${projectId}/issues/1` },
    correlationId: "corr_01K0000000000000000000",
    causationId: null,
    payload: {},
    ...overrides,
  };
}

describe("EventPublisher + OutboxDispatcher pipeline", () => {
  it("delivers a fact to every enabled consumer in its own Project, none in another, and zero when unconsumed — all journaled once, project-scoped", () => {
    const clock = new ControllableClock(new Date("2026-08-28T08:00:00.000Z"));
    const ids = new DeterministicIdGenerator();
    const { db: database, store } = openDb(clock);

    activate(store, "project-a", [
      { instanceId: "rules-1", moduleId: "jarvis.module.automation-rules", enabled: true },
      { instanceId: "rules-2", moduleId: "jarvis.module.automation-rules", enabled: true },
      { instanceId: "rules-3", moduleId: "jarvis.module.automation-rules", enabled: false },
    ]);
    // Same consumed contract, different Project: must never receive project-a's Delivery.
    activate(store, "project-b", [
      { instanceId: "rules-1", moduleId: "jarvis.module.automation-rules", enabled: true },
    ]);

    const registry = new EventEnvelopeContractRegistry({ eventEnvelopeV1: envelopeSchema });
    const publisher = new EventPublisher(database, clock, ids, registry);
    const dispatcher = new OutboxDispatcher(
      database,
      clock,
      ids,
      registry,
      openSubscriptionsPort(store),
    );

    const consumed = database.transaction(() => publisher.publish(factInput("project-a")))();
    const unconsumedType = database.transaction(() =>
      publisher.publish(factInput("project-a", { type: "scm.change-request.created" })),
    )();

    const dispatched = dispatcher.dispatchPending();
    expect(dispatched).toHaveLength(2);

    const consumedDeliveries = database
      .prepare(
        "SELECT module_instance_id, project_id FROM deliveries WHERE event_id = ? ORDER BY module_instance_id",
      )
      .all(consumed.id) as { module_instance_id: string; project_id: string }[];
    expect(consumedDeliveries).toEqual([
      { module_instance_id: "rules-1", project_id: "project-a" },
      { module_instance_id: "rules-2", project_id: "project-a" },
    ]);

    // Zero consumers is legal: still journaled, no Delivery row at all.
    expect(
      database.prepare("SELECT 1 FROM deliveries WHERE event_id = ?").get(unconsumedType.id),
    ).toBeUndefined();
    expect(
      database.prepare("SELECT 1 FROM events WHERE id = ?").get(unconsumedType.id),
    ).toBeDefined();

    // project-b's identically-consuming instance received nothing.
    expect(
      database.prepare("SELECT 1 FROM deliveries WHERE project_id = 'project-b'").get(),
    ).toBeUndefined();

    // project scoping: every row of every table carries the right project_id.
    const journaled = database
      .prepare("SELECT project_id FROM events WHERE id = ?")
      .get(consumed.id) as { project_id: string };
    expect(journaled.project_id).toBe("project-a");
    expect(
      database.prepare("SELECT status FROM outbox WHERE event_id = ?").get(consumed.id),
    ).toEqual({ status: "dispatched" });
  });

  it("does not duplicate the journal entry or Deliveries when the same event id is dispatched a second time", () => {
    const clock = new ControllableClock(new Date("2026-08-28T08:00:00.000Z"));
    const ids = new DeterministicIdGenerator();
    const { db: database, store } = openDb(clock);
    activate(store, "project-a", [
      { instanceId: "rules-1", moduleId: "jarvis.module.automation-rules", enabled: true },
    ]);

    const registry = new EventEnvelopeContractRegistry({ eventEnvelopeV1: envelopeSchema });
    const publisher = new EventPublisher(database, clock, ids, registry);
    const dispatcher = new OutboxDispatcher(
      database,
      clock,
      ids,
      registry,
      openSubscriptionsPort(store),
    );

    const envelope = database.transaction(() => publisher.publish(factInput("project-a")))();
    dispatcher.dispatchPending();

    // Simulate a stray reclaim of the same event id — the row falls back to
    // pending and its lease expires, so the next pass genuinely re-claims it —
    // and dispatch again: the journal/Delivery uniqueness guards must hold.
    database.prepare("UPDATE outbox SET status = 'pending' WHERE event_id = ?").run(envelope.id);
    clock.advance(60_000);
    expect(dispatcher.dispatchPending()).toHaveLength(1);

    expect(
      database.prepare("SELECT COUNT(*) AS n FROM events WHERE id = ?").get(envelope.id),
    ).toEqual({ n: 1 });
    expect(
      database.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE event_id = ?").get(envelope.id),
    ).toEqual({ n: 1 });
  });

  it("does not re-claim a row whose lease is still held, and re-claims it once that lease expires", () => {
    const clock = new ControllableClock(new Date("2026-08-28T08:00:00.000Z"));
    const ids = new DeterministicIdGenerator();
    const { db: database, store } = openDb(clock);
    activate(store, "project-a", [
      { instanceId: "rules-1", moduleId: "jarvis.module.automation-rules", enabled: true },
    ]);

    const registry = new EventEnvelopeContractRegistry({ eventEnvelopeV1: envelopeSchema });
    const publisher = new EventPublisher(database, clock, ids, registry);
    const leaseMs = 30_000;
    const dispatcher = new OutboxDispatcher(
      database,
      clock,
      ids,
      registry,
      openSubscriptionsPort(store),
      leaseMs,
    );

    const envelope = database.transaction(() => publisher.publish(factInput("project-a")))();
    dispatcher.dispatchPending();
    // A dispatcher that died before marking the row leaves it pending under a
    // live lease: no second dispatcher may pick it up while that lease holds.
    database.prepare("UPDATE outbox SET status = 'pending' WHERE event_id = ?").run(envelope.id);

    expect(dispatcher.dispatchPending()).toHaveLength(0);

    clock.advance(leaseMs + 1_000);
    expect(dispatcher.dispatchPending()).toHaveLength(1);
    expect(
      database.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE event_id = ?").get(envelope.id),
    ).toEqual({ n: 1 });
  });

  it("leaves no journal entry, no Delivery and the Outbox row still pending when routing resolution fails mid-dispatch", () => {
    const clock = new ControllableClock(new Date("2026-08-28T08:00:00.000Z"));
    const ids = new DeterministicIdGenerator();
    const { db: database, store } = openDb(clock);
    activate(store, "project-a", [
      { instanceId: "rules-1", moduleId: "jarvis.module.automation-rules", enabled: true },
    ]);

    const registry = new EventEnvelopeContractRegistry({ eventEnvelopeV1: envelopeSchema });
    const publisher = new EventPublisher(database, clock, ids, registry);
    const failingRouting: OpenSubscriptionsPort = () => {
      throw new Error("routing collaborator failed");
    };
    const dispatcher = new OutboxDispatcher(database, clock, ids, registry, failingRouting);

    const envelope = database.transaction(() => publisher.publish(factInput("project-a")))();

    expect(() => dispatcher.dispatchPending()).toThrow("routing collaborator failed");

    expect(database.prepare("SELECT 1 FROM events WHERE id = ?").get(envelope.id)).toBeUndefined();
    expect(
      database.prepare("SELECT 1 FROM deliveries WHERE event_id = ?").get(envelope.id),
    ).toBeUndefined();
    expect(
      database.prepare("SELECT status FROM outbox WHERE event_id = ?").get(envelope.id),
    ).toEqual({
      status: "pending",
    });
  });

  it("rejects an invalid envelope at dispatch time with event.envelope-invalid", () => {
    const clock = new ControllableClock(new Date("2026-08-28T08:00:00.000Z"));
    const ids = new DeterministicIdGenerator();
    const { db: database, store } = openDb(clock);
    activate(store, "project-a", []);

    // Bypasses EventPublisher to plant an outbox row whose stored envelope
    // does not satisfy the v1 contract, proving the dispatcher's own runtime
    // validation (docs/engineering/CONTRACT_VALIDATION.md "before journal commit").
    database
      .prepare(
        `INSERT INTO outbox (event_id, project_id, envelope, status, created_at)
         VALUES ('evt_corrupt', 'project-a', '{"not":"an envelope"}', 'pending', ?)`,
      )
      .run(clock.now().toISOString());

    const registry = new EventEnvelopeContractRegistry({ eventEnvelopeV1: envelopeSchema });
    const dispatcher = new OutboxDispatcher(
      database,
      clock,
      ids,
      registry,
      openSubscriptionsPort(store),
    );

    let error: unknown;
    try {
      dispatcher.dispatchPending();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).code).toBe("event.envelope-invalid");
    expect(database.prepare("SELECT 1 FROM events WHERE id = 'evt_corrupt'").get()).toBeUndefined();
  });
});
