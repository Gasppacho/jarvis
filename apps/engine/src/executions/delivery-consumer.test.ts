import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Clock } from "../../../../packages/kernel/src/clock.js";
import { FakeRuntime } from "../../../../packages/agent-runtime/src/index.js";
import { EventEnvelopeContractRegistry } from "../../../../packages/eventing/src/envelope.js";
import { DEFAULT_MAX_ATTEMPTS } from "../../../../packages/eventing/src/retry-policy.js";
import { deriveProjectSubscriptions } from "../../../../packages/project-runtime/src/project-subscriptions.js";
import type {
  ProjectModuleInstanceConfiguration,
  StoredPortableProjectConfiguration,
} from "../../../../packages/project-runtime/src/project-types.js";
import { applyMigrations } from "../db/test-migrations.js";
import { EngineError } from "../errors.js";
import { ProjectStore, type ResolvedProjectSnapshot } from "../projects/store.js";
import { OutboxDispatcher, type OpenSubscriptionsPort } from "../events/dispatcher.js";
import { EventPublisher } from "../events/publisher.js";
import { ControllableClock, DeterministicIdGenerator } from "../events/test-doubles.js";
import { tickEventLoop } from "../events/dispatch-loop.js";
import {
  DeliveryConsumer,
  type ModuleCapabilityLookup,
  type ModuleConfigurationLookup,
  type ModuleHandlerContext,
  type ModuleHandlerLookup,
  type ModulePublishedContractsLookup,
} from "./delivery-consumer.js";
import {
  SAMPLE_PROBE_MODULE_ID,
  SAMPLE_PROBE_PINGED,
  SAMPLE_PROBE_PONGED,
  createSampleProbeSchema,
  createSampleProbeHandler,
} from "./sample-probe-module.js";

/**
 * Ticket #57's Application Harness seam (issue #57 "Test seam"): the real
 * pipeline end to end — `EventPublisher` publishes, `OutboxDispatcher`
 * dispatches, `DeliveryConsumer` consumes into the deterministic sample
 * Module's handler — against real SQLite and the real
 * `deriveProjectSubscriptions`, no mocks. Follows `dispatcher.test.ts`'s
 * shape.
 */

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const envelopeSchema = JSON.parse(
  readFileSync(`${ROOT}/contracts/schemas/event-envelope.v1.schema.json`, "utf8"),
) as object;

let db: Database.Database | undefined;
afterEach(() => db?.close());

function openDb(): Database.Database {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  createSampleProbeSchema(db);
  return db;
}

const COMPOSITIONS: Record<string, { consumes: readonly (typeof SAMPLE_PROBE_PINGED)[] }> = {
  [SAMPLE_PROBE_MODULE_ID]: { consumes: [SAMPLE_PROBE_PINGED] },
};

function activate(
  store: ProjectStore,
  projectId: string,
  instances: readonly ProjectModuleInstanceConfiguration[],
): void {
  const draft: StoredPortableProjectConfiguration = {
    apiVersion: "jarvis.dev/project/v1",
    kind: "Project",
    metadata: { id: projectId, name: projectId },
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
  store.createProject({
    id: projectId,
    name: projectId,
    status: "draft",
    portableConfig: draft,
    repositoryPath: `/tmp/${projectId}`,
  });
  const snapshot: ResolvedProjectSnapshot = {
    composition: draft,
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

function pingInput(projectId: string, overrides: Record<string, unknown> = {}) {
  return {
    type: SAMPLE_PROBE_PINGED.type,
    version: SAMPLE_PROBE_PINGED.version,
    kind: SAMPLE_PROBE_PINGED.kind,
    projectId,
    producer: { moduleId: "jarvis.module.github", moduleInstanceId: "github" },
    subject: { type: "work-item", ref: `github://acme/${projectId}/issues/1` },
    correlationId: "corr_01K0000000000000000000",
    causationId: null,
    payload: {},
    ...overrides,
  };
}

interface Harness {
  readonly db: Database.Database;
  readonly clock: ControllableClock;
  readonly ids: DeterministicIdGenerator;
  readonly store: ProjectStore;
  readonly publisher: EventPublisher;
  readonly dispatcher: OutboxDispatcher;
  readonly consumer: DeliveryConsumer;
}

function harness(
  handlers?: ModuleHandlerLookup,
  configurations?: ModuleConfigurationLookup,
  publishedContracts?: ModulePublishedContractsLookup,
  capabilities?: ModuleCapabilityLookup,
  retryRandom: () => number = () => 0,
): Harness {
  const clock = new ControllableClock(new Date("2026-09-06T08:00:00.000Z"));
  const ids = new DeterministicIdGenerator();
  const database = openDb();
  const store = new ProjectStore(database, clock);
  const registry = new EventEnvelopeContractRegistry({ eventEnvelopeV1: envelopeSchema });
  const publisher = new EventPublisher(database, clock, ids, registry);
  const registeredHandlers = handlers ?? (() => createSampleProbeHandler(database));
  const dispatcher = new OutboxDispatcher(
    database,
    clock,
    ids,
    registry,
    openSubscriptionsPort(store),
  );
  const consumer = new DeliveryConsumer(
    database,
    clock,
    ids,
    publisher,
    registeredHandlers,
    configurations,
    undefined,
    publishedContracts,
    capabilities,
    undefined,
    retryRandom,
  );
  return { db: database, clock, ids, store, publisher, dispatcher, consumer };
}

describe("DeliveryConsumer", () => {
  it("passes project-scoped configuration alongside the event context and defaults missing configuration to empty", () => {
    const seen: ModuleHandlerContext[] = [];
    const handler = (context: ModuleHandlerContext) => {
      seen.push(context);
      return { accepted: true };
    };
    const runtime = new FakeRuntime();
    const { store, publisher, dispatcher, consumer } = harness(
      () => handler,
      (projectId, moduleInstanceId) =>
        projectId === "project-a" && moduleInstanceId === "probe-1"
          ? { enabled: true, rules: [{ id: "rule-1" }] }
          : undefined,
      undefined,
      () => ({ agentRuntime: runtime }),
    );
    activate(store, "project-a", [
      { instanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
    ]);
    activate(store, "project-b", [
      { instanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
    ]);

    const published = publisher.publish(pingInput("project-a"));
    const publishedWithoutConfiguration = publisher.publish(pingInput("project-b"));
    dispatcher.dispatchPending();
    const outcome = consumer.consume({
      projectId: "project-a",
      moduleInstanceId: "probe-1",
      moduleId: SAMPLE_PROBE_MODULE_ID,
      eventId: published.id,
    });
    consumer.consume({
      projectId: "project-b",
      moduleInstanceId: "probe-1",
      moduleId: SAMPLE_PROBE_MODULE_ID,
      eventId: publishedWithoutConfiguration.id,
    });

    expect(outcome.status).toBe("completed");
    expect(seen.find((context) => context.projectId === "project-a")).toMatchObject({
      projectId: "project-a",
      moduleInstanceId: "probe-1",
      event: { id: published.id },
      configuration: { enabled: true, rules: [{ id: "rule-1" }] },
      capabilities: { agentRuntime: runtime },
    });
    expect(seen.find((context) => context.projectId === "project-b")).toMatchObject({
      projectId: "project-b",
      moduleInstanceId: "probe-1",
      event: { id: publishedWithoutConfiguration.id },
      configuration: {},
    });
  });

  it("runs the sample Module's handler once, records one completed Execution, and publishes a caused/correlated fact", () => {
    const { db: database, store, publisher, dispatcher, consumer } = harness();
    activate(store, "project-a", [
      { instanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
    ]);

    const consumed = database.transaction(() => publisher.publish(pingInput("project-a")))();
    const dispatched = dispatcher.dispatchPending();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.deliveries).toEqual([
      { moduleInstanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID },
    ]);

    const outcome = consumer.consume({
      projectId: "project-a",
      moduleInstanceId: "probe-1",
      moduleId: SAMPLE_PROBE_MODULE_ID,
      eventId: consumed.id,
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.redelivered).toBe(false);
    expect(outcome.executionId).not.toBeNull();

    // Acceptance criterion 1 + 5 + 7: one completed Execution, queryable per Project.
    const executions = database
      .prepare(
        `SELECT project_id, module_instance_id, module_id, input_event_id, attempt, status FROM executions WHERE project_id = ?`,
      )
      .all("project-a");
    expect(executions).toEqual([
      {
        project_id: "project-a",
        module_instance_id: "probe-1",
        module_id: SAMPLE_PROBE_MODULE_ID,
        input_event_id: consumed.id,
        attempt: 1,
        status: "completed",
      },
    ]);

    // Module state mutation happened and Delivery is marked consumed.
    expect(
      database
        .prepare(
          `SELECT ping_count FROM sample_probe_state WHERE project_id = ? AND module_instance_id = ?`,
        )
        .get("project-a", "probe-1"),
    ).toEqual({ ping_count: 1 });
    expect(
      database.prepare(`SELECT consumed_at FROM deliveries WHERE event_id = ?`).get(consumed.id),
    ).not.toEqual({ consumed_at: null });

    // Acceptance criterion 6: the handler's published fact carries the
    // consumed event as causation and preserves the correlation chain.
    const outboxRows = database
      .prepare(`SELECT envelope FROM outbox WHERE event_id != ?`)
      .all(consumed.id) as { envelope: string }[];
    expect(outboxRows).toHaveLength(1);
    const echoed = JSON.parse(outboxRows[0]!.envelope) as {
      type: string;
      causationId: string;
      correlationId: string;
    };
    expect(echoed.type).toBe(SAMPLE_PROBE_PONGED.type);
    expect(echoed.causationId).toBe(consumed.id);
    expect(echoed.correlationId).toBe(consumed.correlationId);

    // Dispatching the echoed fact proves it lands in the existing dispatcher too.
    const secondDispatch = dispatcher.dispatchPending();
    expect(secondDispatch).toHaveLength(1);
  });

  it("derives the producer identity from the claimed Delivery", () => {
    const handler = (context: ModuleHandlerContext) =>
      context.publish({
        type: SAMPLE_PROBE_PONGED.type,
        version: SAMPLE_PROBE_PONGED.version,
        kind: SAMPLE_PROBE_PONGED.kind,
        subject: context.event.subject,
        payload: {},
      });
    const { db: database, store, publisher, dispatcher, consumer } = harness(() => handler);
    activate(store, "project-a", [
      { instanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
    ]);

    const consumed = database.transaction(() => publisher.publish(pingInput("project-a")))();
    dispatcher.dispatchPending();
    consumer.consume({
      projectId: "project-a",
      moduleInstanceId: "probe-1",
      moduleId: SAMPLE_PROBE_MODULE_ID,
      eventId: consumed.id,
    });

    const emitted = database
      .prepare("SELECT envelope FROM outbox WHERE event_id != ?")
      .get(consumed.id) as { readonly envelope: string };
    expect(JSON.parse(emitted.envelope)).toMatchObject({
      producer: { moduleId: SAMPLE_PROBE_MODULE_ID, moduleInstanceId: "probe-1" },
    });
  });

  it("rejects an outgoing event absent from the Module manifest", () => {
    const handler = (context: ModuleHandlerContext) =>
      context.publish({
        type: "scm.work-item.tag-added",
        version: 1,
        kind: "fact",
        subject: context.event.subject,
        payload: {},
      });
    const {
      db: database,
      store,
      publisher,
      dispatcher,
      consumer,
    } = harness(
      () => handler,
      undefined,
      () => [],
    );
    activate(store, "project-a", [
      { instanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
    ]);

    const consumed = database.transaction(() => publisher.publish(pingInput("project-a")))();
    dispatcher.dispatchPending();
    const outcome = consumer.consume({
      projectId: "project-a",
      moduleInstanceId: "probe-1",
      moduleId: SAMPLE_PROBE_MODULE_ID,
      eventId: consumed.id,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.result).toMatchObject({
      error: expect.stringContaining("cannot publish undeclared"),
    });
    expect(database.prepare("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 1 });
  });

  it("delivers the same event to two different Module Instances and runs both handlers — Inbox uniqueness is per consumer, not per event", () => {
    const { db: database, store, publisher, dispatcher, consumer } = harness();
    activate(store, "project-a", [
      { instanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
      { instanceId: "probe-2", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
    ]);

    const consumed = database.transaction(() => publisher.publish(pingInput("project-a")))();
    dispatcher.dispatchPending();

    const first = consumer.consume({
      projectId: "project-a",
      moduleInstanceId: "probe-1",
      moduleId: SAMPLE_PROBE_MODULE_ID,
      eventId: consumed.id,
    });
    const second = consumer.consume({
      projectId: "project-a",
      moduleInstanceId: "probe-2",
      moduleId: SAMPLE_PROBE_MODULE_ID,
      eventId: consumed.id,
    });

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(first.executionId).not.toBe(second.executionId);

    expect(
      database.prepare(`SELECT COUNT(*) AS n FROM inbox WHERE event_id = ?`).get(consumed.id),
    ).toEqual({ n: 2 });
    expect(
      database
        .prepare(`SELECT COUNT(*) AS n FROM executions WHERE input_event_id = ?`)
        .get(consumed.id),
    ).toEqual({ n: 2 });
    expect(
      database
        .prepare(
          `SELECT ping_count FROM sample_probe_state WHERE project_id = ? AND module_instance_id = ?`,
        )
        .get("project-a", "probe-1"),
    ).toEqual({ ping_count: 1 });
    expect(
      database
        .prepare(
          `SELECT ping_count FROM sample_probe_state WHERE project_id = ? AND module_instance_id = ?`,
        )
        .get("project-a", "probe-2"),
    ).toEqual({ ping_count: 1 });
  });

  it("redelivering the same event id to the same consumer returns the recorded result, does not re-run the side effect and creates no second Execution", () => {
    const { db: database, store, publisher, dispatcher, consumer } = harness();
    activate(store, "project-a", [
      { instanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
    ]);

    const consumed = database.transaction(() => publisher.publish(pingInput("project-a")))();
    dispatcher.dispatchPending();

    const delivery = {
      projectId: "project-a",
      moduleInstanceId: "probe-1",
      moduleId: SAMPLE_PROBE_MODULE_ID,
      eventId: consumed.id,
    };
    const first = consumer.consume(delivery);
    // Redispatching the same event id again (issue #57 test seam: "redelivery
    // asserted by dispatching the same event id twice") reproduces the same
    // (event, instance) pairing without creating a second Delivery row.
    dispatcher.dispatchPending();
    const second = consumer.consume(delivery);

    expect(second.redelivered).toBe(true);
    expect(second.executionId).toBeNull();
    expect(second.status).toBe(first.status);
    expect(second.result).toEqual(first.result);

    expect(
      database
        .prepare(
          `SELECT ping_count FROM sample_probe_state WHERE project_id = ? AND module_instance_id = ?`,
        )
        .get("project-a", "probe-1"),
    ).toEqual({ ping_count: 1 });
    expect(
      database
        .prepare(`SELECT COUNT(*) AS n FROM executions WHERE input_event_id = ?`)
        .get(consumed.id),
    ).toEqual({ n: 1 });
    // Only the one echoed fact from the first, real run — no second publish.
    expect(
      database.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE event_id != ?`).get(consumed.id),
    ).toEqual({ n: 1 });
  });

  it("a handler that throws leaves the Inbox, Module state, Outbox and Delivery completion untouched, and records a failed Execution", () => {
    const { db: database, store, publisher, dispatcher, consumer } = harness();
    activate(store, "project-a", [
      { instanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
    ]);

    const consumed = database.transaction(() =>
      publisher.publish(pingInput("project-a", { payload: { shouldFail: true } })),
    )();
    dispatcher.dispatchPending();

    const outcome = consumer.consume({
      projectId: "project-a",
      moduleInstanceId: "probe-1",
      moduleId: SAMPLE_PROBE_MODULE_ID,
      eventId: consumed.id,
    });

    expect(outcome.status).toBe("failed");

    // The failing attempt's own state mutation rolled back with everything else.
    expect(
      database
        .prepare(
          `SELECT ping_count FROM sample_probe_state WHERE project_id = ? AND module_instance_id = ?`,
        )
        .get("project-a", "probe-1"),
    ).toBeUndefined();
    expect(
      database.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE event_id != ?`).get(consumed.id),
    ).toEqual({ n: 0 });

    // The Execution is still recorded, as failed — not a retry schedule (#17 stays out of scope).
    const execution = database
      .prepare(`SELECT status, error FROM executions WHERE input_event_id = ?`)
      .get(consumed.id) as { status: string; error: string };
    expect(execution.status).toBe("failed");
    expect(execution.error).toMatch(/deterministic failure/);

    // Redelivery of a failed consumption also returns the recorded outcome without retrying.
    const redelivered = consumer.consume({
      projectId: "project-a",
      moduleInstanceId: "probe-1",
      moduleId: SAMPLE_PROBE_MODULE_ID,
      eventId: consumed.id,
    });
    expect(redelivered.redelivered).toBe(true);
    expect(redelivered.status).toBe("failed");
    expect(
      database
        .prepare(`SELECT COUNT(*) AS n FROM executions WHERE input_event_id = ?`)
        .get(consumed.id),
    ).toEqual({ n: 1 });
    // Fix review #57: the failure path must complete the Delivery too, not
    // just the happy path (previously only asserted above).
    expect(
      database.prepare(`SELECT consumed_at FROM deliveries WHERE event_id = ?`).get(consumed.id),
    ).not.toEqual({ consumed_at: null });
  });

  it("leaves a retryable failure unfinished with its next attempt scheduled", () => {
    let calls = 0;
    const handler = (context: ModuleHandlerContext) => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("transient provider outage"), {
          code: "provider.unavailable",
          retryable: true,
        });
      }
      return { accepted: true };
    };
    const { db: database, store, publisher, dispatcher, consumer } = harness(() => handler);
    activate(store, "project-a", [
      { instanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
    ]);

    const published = publisher.publish(pingInput("project-a"));
    dispatcher.dispatchPending();
    const delivery = {
      projectId: "project-a",
      moduleInstanceId: "probe-1",
      moduleId: SAMPLE_PROBE_MODULE_ID,
      eventId: published.id,
    };

    const outcome = consumer.consume(delivery);

    expect(outcome.status).toBe("failed");
    expect(calls).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS n FROM inbox").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT consumed_at FROM deliveries").get()).toEqual({
      consumed_at: null,
    });
    expect(
      database
        .prepare("SELECT attempt, status FROM executions WHERE input_event_id = ? ORDER BY attempt")
        .all(published.id),
    ).toEqual([{ attempt: 1, status: "failed" }]);
    expect(database.prepare("SELECT attempt_count, next_attempt_at FROM deliveries").get()).toEqual(
      expect.objectContaining({ attempt_count: 1, next_attempt_at: expect.any(String) }),
    );
  });

  it("does not re-offer a retryable Delivery before due and succeeds on its next attempt", async () => {
    let database!: Database.Database;
    let calls = 0;
    const handler = (context: ModuleHandlerContext) => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("transient provider outage"), {
          code: "provider.unavailable",
          retryable: true,
        });
      }
      return createSampleProbeHandler(database)(context);
    };
    const harnessState = harness(
      () => handler,
      undefined,
      undefined,
      undefined,
      () => 0,
    );
    database = harnessState.db;
    const { clock, store, publisher, dispatcher, consumer } = harnessState;
    activate(store, "project-a", [
      { instanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
    ]);
    publisher.publish(pingInput("project-a"));

    const liveUpdates = { publish: () => {} };
    await tickEventLoop({ db: database, clock, dispatcher, consumer, liveUpdates });
    expect(calls).toBe(1);

    clock.advance(499);
    await tickEventLoop({ db: database, clock, dispatcher, consumer, liveUpdates });
    expect(calls).toBe(1);

    clock.advance(1);
    await tickEventLoop({ db: database, clock, dispatcher, consumer, liveUpdates });
    expect(calls).toBe(2);
    expect(database.prepare("SELECT ping_count FROM sample_probe_state").get()).toEqual({
      ping_count: 1,
    });
    expect(
      database.prepare("SELECT attempt, status FROM executions ORDER BY attempt").all(),
    ).toEqual([
      { attempt: 1, status: "failed" },
      { attempt: 2, status: "completed" },
    ]);
    expect(database.prepare("SELECT attempt FROM inbox").get()).toEqual({ attempt: 2 });
    expect(
      database.prepare("SELECT consumed_at, attempt_count, next_attempt_at FROM deliveries").get(),
    ).toMatchObject({
      attempt_count: 2,
      next_attempt_at: null,
    });
  });

  it("dead-letters a retryable Delivery exactly once when its attempts are exhausted", () => {
    let database!: Database.Database;
    let calls = 0;
    const handler = () => {
      calls += 1;
      throw Object.assign(new Error("provider stayed unavailable at /Users/alice/.cache"), {
        code: "provider.unavailable",
        retryable: true,
      });
    };
    const harnessState = harness(
      () => handler,
      undefined,
      undefined,
      undefined,
      () => 0,
    );
    database = harnessState.db;
    const { clock, store, publisher, dispatcher, consumer } = harnessState;
    activate(store, "project-a", [
      { instanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
    ]);
    const published = publisher.publish(pingInput("project-a"));
    dispatcher.dispatchPending();
    const delivery = {
      projectId: "project-a",
      moduleInstanceId: "probe-1",
      moduleId: SAMPLE_PROBE_MODULE_ID,
      eventId: published.id,
    };

    for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        const nextAttempt = database.prepare("SELECT next_attempt_at FROM deliveries").get() as {
          next_attempt_at: string;
        };
        clock.advance(Date.parse(nextAttempt.next_attempt_at) - clock.now().getTime() + 1);
      }
      expect(consumer.consume(delivery).status).toBe("failed");
    }

    expect(calls).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(database.prepare("SELECT COUNT(*) AS n FROM executions").get()).toEqual({
      n: DEFAULT_MAX_ATTEMPTS,
    });
    expect(database.prepare("SELECT COUNT(*) AS n FROM inbox").get()).toEqual({ n: 0 });
    const deadLetter = database
      .prepare("SELECT code, attempts, message, last_execution_id FROM dead_letters")
      .get() as {
      code: string;
      attempts: number;
      message: string;
      last_execution_id: string;
    };
    expect(deadLetter).toMatchObject({
      code: "delivery.retry-exhausted",
      attempts: DEFAULT_MAX_ATTEMPTS,
      message: "provider stayed unavailable at <path>",
    });
    expect(deadLetter.last_execution_id).toBe(
      database.prepare("SELECT id FROM executions ORDER BY attempt DESC LIMIT 1").pluck().get(),
    );
    expect(
      database.prepare("SELECT consumed_at, next_attempt_at FROM deliveries").get(),
    ).toMatchObject({
      next_attempt_at: null,
      consumed_at: expect.any(String),
    });

    const redelivery = consumer.consume(delivery);
    expect(redelivery).toMatchObject({
      executionId: null,
      redelivered: true,
      status: "failed",
    });
    expect(calls).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(database.prepare("SELECT COUNT(*) AS n FROM dead_letters").get()).toEqual({ n: 1 });
  });

  it("a failure while recording a handler failure surfaces as a labeled EngineError instead of the raw constraint error, and does not lose the original handler failure", () => {
    const { db: database, store, publisher, dispatcher, consumer } = harness();
    activate(store, "project-a", [
      { instanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
    ]);

    const consumed = database.transaction(() =>
      publisher.publish(pingInput("project-a", { payload: { shouldFail: true } })),
    )();
    dispatcher.dispatchPending();

    // Make only the failure-recording transaction fail. The handler still
    // runs and fails first, so the original handler error must survive the
    // wrapper without relying on an Execution collision before invocation.
    database.exec(
      "CREATE TRIGGER fail_inbox_recording BEFORE INSERT ON inbox " +
        "WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'deterministic inbox recording failure'); END",
    );

    const delivery = {
      projectId: "project-a",
      moduleInstanceId: "probe-1",
      moduleId: SAMPLE_PROBE_MODULE_ID,
      eventId: consumed.id,
    };

    let thrown: unknown;
    try {
      consumer.consume(delivery);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EngineError);
    const engineError = thrown as EngineError;
    expect(engineError.code).toBe("system.internal-error");
    // The original handler failure must not be lost inside the wrapper.
    expect(engineError.message).toMatch(/deterministic failure/);

    // The Delivery is left unresolved (no retry schedule exists yet — #17):
    // this is a loud failure, not a silent strand.
    expect(
      database.prepare(`SELECT consumed_at FROM deliveries WHERE event_id = ?`).get(consumed.id),
    ).toEqual({ consumed_at: null });
  });

  it("rejects a ClaimedDelivery naming another Project's id instead of silently consuming across Projects (AGENTS.md invariant 9)", () => {
    const { db: database, store, publisher, dispatcher, consumer } = harness();
    activate(store, "project-a", [
      { instanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
    ]);
    activate(store, "project-b", [
      { instanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
    ]);

    const consumed = database.transaction(() => publisher.publish(pingInput("project-a")))();
    dispatcher.dispatchPending();

    // Same event id and consumer shape, but claiming Project B — the event
    // actually lives under Project A.
    expect(() =>
      consumer.consume({
        projectId: "project-b",
        moduleInstanceId: "probe-1",
        moduleId: SAMPLE_PROBE_MODULE_ID,
        eventId: consumed.id,
      }),
    ).toThrow(/no journaled event/i);

    // Nothing was written under either Project as a side effect of the
    // rejected cross-project claim.
    expect(
      database.prepare(`SELECT COUNT(*) AS n FROM inbox WHERE event_id = ?`).get(consumed.id),
    ).toEqual({ n: 0 });
    expect(
      database
        .prepare(`SELECT COUNT(*) AS n FROM executions WHERE input_event_id = ?`)
        .get(consumed.id),
    ).toEqual({ n: 0 });
    expect(
      database
        .prepare(
          `SELECT consumed_at FROM deliveries WHERE event_id = ? AND project_id = 'project-a'`,
        )
        .get(consumed.id),
    ).toEqual({ consumed_at: null });
  });

  it("awaits an async handler before committing its terminal records and buffers publications", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const handler = async (context: ModuleHandlerContext) => {
      started = true;
      await gate;
      context.publish({
        type: SAMPLE_PROBE_PONGED.type,
        version: SAMPLE_PROBE_PONGED.version,
        kind: SAMPLE_PROBE_PONGED.kind,
        subject: context.event.subject,
        payload: { async: true },
      });
      return { accepted: true };
    };
    const { db: database, store, publisher, dispatcher, consumer } = harness(() => handler);
    activate(store, "project-a", [
      { instanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
    ]);

    const consumed = publisher.publish(pingInput("project-a"));
    dispatcher.dispatchPending();
    const delivery = {
      projectId: "project-a",
      moduleInstanceId: "probe-1",
      moduleId: SAMPLE_PROBE_MODULE_ID,
      eventId: consumed.id,
    };
    const pending = consumer.consume(delivery);

    expect(started).toBe(true);
    expect(database.prepare("SELECT status FROM executions").get()).toEqual({ status: "running" });
    expect(database.prepare("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 1 });

    release();
    const outcome = await pending;

    expect(outcome.status).toBe("completed");
    expect(outcome.result).toEqual({ accepted: true });
    expect(database.prepare("SELECT COUNT(*) AS n FROM executions").get()).toEqual({ n: 1 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 2 });
  });

  it("lets a synchronous handler record a checkpoint before its Ledger row is terminal", () => {
    const handler = (context: ModuleHandlerContext) => {
      context.recordCheckpoint({
        type: "agent.started",
        sequence: 1,
        timestamp: "2026-09-06T08:00:00.000Z",
      });
      return { accepted: true };
    };
    const { db: database, store, publisher, dispatcher, consumer } = harness(() => handler);
    activate(store, "project-a", [
      { instanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
    ]);

    const consumed = publisher.publish(pingInput("project-a"));
    dispatcher.dispatchPending();
    const outcome = consumer.consume({
      projectId: "project-a",
      moduleInstanceId: "probe-1",
      moduleId: SAMPLE_PROBE_MODULE_ID,
      eventId: consumed.id,
    });

    expect(outcome.status).toBe("completed");
    expect(database.prepare("SELECT status FROM executions").get()).toEqual({
      status: "completed",
    });
    expect(database.prepare("SELECT type, sequence FROM execution_checkpoints").all()).toEqual([
      { type: "agent.started", sequence: 1 },
    ]);
  });

  it("records a timed-out async result as a distinct terminal outcome", async () => {
    const handler = async () => ({
      status: "timed-out" as const,
      summary: "timed out",
      changedFiles: [],
    });
    const { db: database, store, publisher, dispatcher, consumer } = harness(() => handler);
    activate(store, "project-a", [
      { instanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
    ]);

    const consumed = publisher.publish(pingInput("project-a"));
    dispatcher.dispatchPending();
    const delivery = {
      projectId: "project-a",
      moduleInstanceId: "probe-1",
      moduleId: SAMPLE_PROBE_MODULE_ID,
      eventId: consumed.id,
    };
    const outcome = await consumer.consume(delivery);

    expect(outcome.status).toBe("timed-out");
    expect(database.prepare("SELECT status FROM executions").get()).toEqual({
      status: "timed_out",
    });
    expect(database.prepare("SELECT status FROM inbox").get()).toEqual({
      status: "timed_out",
    });
    expect(consumer.consume(delivery)).toMatchObject({
      redelivered: true,
      status: "timed-out",
    });
  });

  it("records an async rejection as failed without committing buffered publications", async () => {
    const handler = async (context: ModuleHandlerContext) => {
      context.publish({
        type: SAMPLE_PROBE_PONGED.type,
        version: SAMPLE_PROBE_PONGED.version,
        kind: SAMPLE_PROBE_PONGED.kind,
        subject: context.event.subject,
        payload: { shouldNotPublish: true },
      });
      throw Object.assign(new Error("async deterministic failure"), {
        code: "sample-probe.async-failure",
        retryable: false,
      });
    };
    const { db: database, store, publisher, dispatcher, consumer } = harness(() => handler);
    activate(store, "project-a", [
      { instanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
    ]);

    const consumed = publisher.publish(pingInput("project-a"));
    dispatcher.dispatchPending();
    const delivery = {
      projectId: "project-a",
      moduleInstanceId: "probe-1",
      moduleId: SAMPLE_PROBE_MODULE_ID,
      eventId: consumed.id,
    };
    const outcome = await consumer.consume(delivery);

    expect(outcome.status).toBe("failed");
    expect(outcome.result).toEqual({
      error: {
        code: "sample-probe.async-failure",
        retryable: false,
        message: "async deterministic failure",
      },
    });
    expect(database.prepare("SELECT COUNT(*) AS n FROM executions").get()).toEqual({ n: 1 });
    expect(database.prepare("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 1 });
    expect(database.prepare("SELECT status, result FROM inbox").get()).toEqual({
      status: "failed",
      result: JSON.stringify({
        error: {
          code: "sample-probe.async-failure",
          retryable: false,
          message: "async deterministic failure",
        },
      }),
    });

    const redelivered = consumer.consume(delivery);
    expect(redelivered).toMatchObject({
      redelivered: true,
      status: "failed",
      result: {
        error: {
          code: "sample-probe.async-failure",
          retryable: false,
          message: "async deterministic failure",
        },
      },
    });
  });

  it("cancels a running async handler through its AbortSignal and records cancelled", async () => {
    let signal!: AbortSignal;
    const handler = (context: ModuleHandlerContext) => {
      signal = context.signal;
      return new Promise<never>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("handler aborted")), {
          once: true,
        });
      });
    };
    const { db: database, store, publisher, dispatcher, consumer } = harness(() => handler);
    activate(store, "project-a", [
      { instanceId: "probe-1", moduleId: SAMPLE_PROBE_MODULE_ID, enabled: true },
    ]);

    const consumed = publisher.publish(pingInput("project-a"));
    dispatcher.dispatchPending();
    const delivery = {
      projectId: "project-a",
      moduleInstanceId: "probe-1",
      moduleId: SAMPLE_PROBE_MODULE_ID,
      eventId: consumed.id,
    };

    const pending = consumer.consumeAsync(delivery);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(database.prepare("SELECT status FROM executions").get()).toEqual({ status: "running" });

    const execution = database.prepare("SELECT id FROM executions").get() as { id: string };
    const cancelling = consumer.cancelExecution(execution.id);
    expect(cancelling).toMatchObject({ id: expect.any(String), status: "cancelling" });
    expect(signal.aborted).toBe(true);

    const outcome = await pending;
    expect(outcome.status).toBe("cancelled");
    expect(database.prepare("SELECT status FROM executions").get()).toEqual({
      status: "cancelled",
    });
    expect(database.prepare("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 1 });
  });
});
