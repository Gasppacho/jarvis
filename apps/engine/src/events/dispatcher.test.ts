import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "../../../../packages/kernel/src/clock.js";
import { EventEnvelopeContractRegistry } from "../../../../packages/eventing/src/envelope.js";
import {
  RequestRoutingError,
  resolveRequestConsumer,
  type RequestEnvelope,
} from "../../../../packages/eventing/src/routing.js";
import { deriveProjectSubscriptions } from "../../../../packages/project-runtime/src/project-subscriptions.js";
import type {
  ProjectModuleInstanceConfiguration,
  StoredPortableProjectConfiguration,
} from "../../../../packages/project-runtime/src/project-types.js";
import { applyMigrations } from "../db/test-migrations.js";
import { ProjectStore, type ResolvedProjectSnapshot } from "../projects/store.js";
import { OutboxDispatcher, type OpenSubscriptionsPort } from "./dispatcher.js";
import { EventPublisher } from "./publisher.js";
import { ControllableClock, DeterministicIdGenerator } from "./test-doubles.js";

/**
 * Ticket #56's highest realistic seam: production inbound adapters are added
 * by later tickets, so this invokes the real `EventPublisher` directly and
 * exercises the real pipeline — SQLite, the real
 * `ProjectStore`/`deriveProjectSubscriptions` a Module activates through,
 * and `EventPublisher` + `OutboxDispatcher` — end to end in one process, no
 * mocks. "Restart-free" per the ticket's test seam: one open connection
 * throughout.
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
const IMPLEMENTATION_REQUEST = {
  type: "development.implementation.requested",
  version: 1,
  kind: "request" as const,
};
const COMPOSITIONS: Record<string, { consumes: readonly (typeof TAG_ADDED)[] }> = {
  "jarvis.module.automation-rules": { consumes: [TAG_ADDED] },
};

function activate(
  store: ProjectStore,
  projectId: string,
  instances: readonly ProjectModuleInstanceConfiguration[],
  overrides: Partial<Pick<ResolvedProjectSnapshot, "bindings" | "requestRoutes">> = {},
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
    bindings: overrides.bindings ?? {
      slots: {},
      repository: { path: `/tmp/${projectId}`, bookmarkRef: null },
    },
    requestRoutes: overrides.requestRoutes ?? [],
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

function requestInput(
  projectId: string,
  target: { readonly binding?: string; readonly moduleInstanceId?: string },
  suffix = target.moduleInstanceId ?? target.binding ?? "target",
) {
  return {
    ...IMPLEMENTATION_REQUEST,
    projectId,
    producer: {
      moduleId: "jarvis.module.automation-rules",
      moduleInstanceId: "automation-rules",
    },
    subject: { type: "work-item", ref: `github://acme/${projectId}/issues/1` },
    correlationId: "corr_01K0000000000000000000",
    causationId: null,
    target,
    idempotencyKey: `${projectId}:request:${suffix}`,
    payload: { workItemRef: "github://acme/token-warehouse/issues/1" },
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

  it("creates exactly one Delivery for a direct or binding-targeted request", () => {
    const clock = new ControllableClock(new Date("2026-08-28T08:00:00.000Z"));
    const ids = new DeterministicIdGenerator();
    const { db: database, store } = openDb(clock);
    const requestRoute = {
      contract: IMPLEMENTATION_REQUEST,
      producer: { instanceId: "automation-rules", moduleId: "jarvis.module.automation-rules" },
      consumer: { instanceId: "development", moduleId: "jarvis.module.development" },
    };
    activate(
      store,
      "project-a",
      [
        {
          instanceId: "automation-rules",
          moduleId: "jarvis.module.automation-rules",
          enabled: true,
          bindings: { implementation: "implementation-slot" },
        },
        { instanceId: "development", moduleId: "jarvis.module.development", enabled: true },
      ],
      {
        bindings: {
          slots: { "implementation-slot": { kind: "module-instance", ref: "development" } },
          repository: { path: "/tmp/project-a", bookmarkRef: null },
        },
        requestRoutes: [requestRoute],
      },
    );
    activate(
      store,
      "project-b",
      [
        {
          instanceId: "automation-rules",
          moduleId: "jarvis.module.automation-rules",
          enabled: true,
          bindings: { implementation: "implementation-slot" },
        },
        { instanceId: "development", moduleId: "jarvis.module.development", enabled: true },
      ],
      {
        bindings: {
          slots: { "implementation-slot": { kind: "module-instance", ref: "development" } },
          repository: { path: "/tmp/project-b", bookmarkRef: null },
        },
        requestRoutes: [requestRoute],
      },
    );

    const registry = new EventEnvelopeContractRegistry({ eventEnvelopeV1: envelopeSchema });
    const publisher = new EventPublisher(database, clock, ids, registry);
    const requestResolver = (projectId: string, envelope: RequestEnvelope) => {
      const snapshot = store.getResolvedProject(projectId);
      return snapshot === undefined ? undefined : resolveRequestConsumer(envelope, snapshot);
    };
    const dispatcher = new OutboxDispatcher(
      database,
      clock,
      ids,
      registry,
      openSubscriptionsPort(store),
      30_000,
      requestResolver,
    );

    const direct = database.transaction(() =>
      publisher.publish(requestInput("project-a", { moduleInstanceId: "development" })),
    )();
    const binding = database.transaction(() =>
      publisher.publish(requestInput("project-a", { binding: "implementation" })),
    )();
    const otherProject = database.transaction(() =>
      publisher.publish(requestInput("project-b", { moduleInstanceId: "development" })),
    )();

    expect(dispatcher.dispatchPending()).toHaveLength(3);
    for (const event of [direct, binding, otherProject]) {
      expect(
        database
          .prepare("SELECT module_instance_id, module_id FROM deliveries WHERE event_id = ?")
          .all(event.id),
      ).toEqual([{ module_instance_id: "development", module_id: "jarvis.module.development" }]);
    }
  });

  it("keeps a request pending and logs the routing error for zero or multiple consumers", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const clock = new ControllableClock(new Date("2026-08-28T08:00:00.000Z"));
      const ids = new DeterministicIdGenerator();
      const { db: database, store } = openDb(clock);
      activate(store, "project-a", []);
      const registry = new EventEnvelopeContractRegistry({ eventEnvelopeV1: envelopeSchema });
      const publisher = new EventPublisher(database, clock, ids, registry);
      const routing = (_projectId: string, envelope: RequestEnvelope) => {
        throw new RequestRoutingError(
          envelope.target?.moduleInstanceId === "missing"
            ? "request-consumer-not-found"
            : "request-consumer-ambiguous",
          "request target resolution failed",
        );
      };
      const dispatcher = new OutboxDispatcher(
        database,
        clock,
        ids,
        registry,
        openSubscriptionsPort(store),
        30_000,
        routing,
      );
      const zero = database.transaction(() =>
        publisher.publish(requestInput("project-a", { moduleInstanceId: "missing" }, "zero")),
      )();
      const multiple = database.transaction(() =>
        publisher.publish(
          requestInput("project-a", { moduleInstanceId: "development" }, "multiple"),
        ),
      )();

      expect(dispatcher.dispatchPending()).toEqual([]);
      expect(
        stderr.mock.calls.filter(([chunk]) =>
          String(chunk).includes("request target resolution failed"),
        ),
      ).toHaveLength(2);
      expect(database.prepare("SELECT status FROM outbox WHERE event_id = ?").get(zero.id)).toEqual(
        { status: "pending" },
      );
      expect(
        database.prepare("SELECT status FROM outbox WHERE event_id = ?").get(multiple.id),
      ).toEqual({ status: "pending" });
      expect(database.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
    } finally {
      stderr.mockRestore();
    }
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

  it(
    "leaves no journal entry, no Delivery and the Outbox row still pending — and does not throw " +
      "or take other rows down with it — when routing resolution fails mid-dispatch",
    () => {
      // Review fix (major) for ticket #58: a per-row failure here used to
      // propagate out of `dispatchPending()` as a thrown exception, which is
      // exactly what let one bad Outbox row crash the always-on dispatch
      // loop (apps/engine/src/events/dispatch-loop.ts) and, since the row
      // stays `pending`, crash-loop the engine forever. It is now isolated
      // per row and logged instead.
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
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

        expect(dispatcher.dispatchPending()).toEqual([]);
        expect(
          stderr.mock.calls.some(([chunk]) =>
            String(chunk).includes("routing collaborator failed"),
          ),
        ).toBe(true);

        expect(
          database.prepare("SELECT 1 FROM events WHERE id = ?").get(envelope.id),
        ).toBeUndefined();
        expect(
          database.prepare("SELECT 1 FROM deliveries WHERE event_id = ?").get(envelope.id),
        ).toBeUndefined();
        expect(
          database.prepare("SELECT status FROM outbox WHERE event_id = ?").get(envelope.id),
        ).toEqual({
          status: "pending",
        });
      } finally {
        stderr.mockRestore();
      }
    },
  );

  it("logs (rather than throws) event.envelope-invalid for an invalid envelope at dispatch time", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
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

      expect(dispatcher.dispatchPending()).toEqual([]);
      expect(
        stderr.mock.calls.some(([chunk]) => String(chunk).includes("event.envelope-invalid")),
      ).toBe(true);
      expect(
        database.prepare("SELECT 1 FROM events WHERE id = 'evt_corrupt'").get(),
      ).toBeUndefined();
    } finally {
      stderr.mockRestore();
    }
  });
});
