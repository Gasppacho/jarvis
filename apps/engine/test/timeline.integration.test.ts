import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { explain, localApiValidator } from "./contract.js";
import { startEngine, type Harness } from "./harness.js";
import { SAMPLE_PROBE_PINGED, SAMPLE_PROBE_PONGED } from "../src/executions/sample-probe-module.js";

/**
 * Ticket #59 (issue #59 "Test seam"): Application Harness — start the real
 * engine with the durability test hooks (apps/engine/src/test-support/
 * durability-test-routes.ts), seed a Project whose Resolved Project has one
 * enabled sample-probe Module Instance, publish a fact that fans out to it,
 * and read both `GET /v1/projects/{projectId}/events` and
 * `GET /v1/projects/{projectId}/executions`. Each published "ping" makes the
 * probe handler both mutate its own state and echo a "pong" fact
 * (sample-probe-module.ts's `sampleProbeHandler`), which is what lets these
 * tests observe a real causation chain (pong.causationId === ping.id) and a
 * real "Fact with zero consumers journals but creates no Execution" case
 * (nothing subscribes to `sample.probe.ponged`) without a bespoke fixture.
 */
const testBundlePath = fileURLToPath(
  new URL("../../../dist/engine/engine.test-bundle.mjs", import.meta.url),
);

interface EventSummary {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly kind: string;
  readonly occurredAt: string;
  readonly producer: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly subjectRef: string;
}

interface ExecutionSummary {
  readonly id: string;
  readonly projectId: string;
  readonly moduleInstanceId: string;
  readonly status: string;
  readonly attempt: number;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly inputEventId?: string;
  readonly correlationId?: string;
}

function pingInput(projectId: string, correlationId: string, subjectRef: string) {
  return {
    type: SAMPLE_PROBE_PINGED.type,
    version: SAMPLE_PROBE_PINGED.version,
    kind: SAMPLE_PROBE_PINGED.kind,
    projectId,
    producer: { moduleId: "jarvis.module.github", moduleInstanceId: "github" },
    subject: { type: "work-item", ref: subjectRef },
    correlationId,
    causationId: null,
    payload: {},
  };
}

const seedProject = (engine: Harness, id: string, moduleInstanceId = "probe-1") =>
  engine.call("/test/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, moduleInstanceId }),
  });

const publishPing = (
  engine: Harness,
  projectId: string,
  correlationId: string,
  subjectRef: string,
) =>
  engine.call("/test/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pingInput(projectId, correlationId, subjectRef)),
  });

async function getEvents(
  engine: Harness,
  projectId: string,
  query = "",
): Promise<{ status: number; items: EventSummary[] }> {
  const response = await engine.call(`/v1/projects/${projectId}/events${query}`);
  const body = (await response.json()) as { items: EventSummary[] };
  return { status: response.status, items: body.items };
}

async function getExecutions(
  engine: Harness,
  projectId: string,
  query = "",
): Promise<{ status: number; items: ExecutionSummary[] }> {
  const response = await engine.call(`/v1/projects/${projectId}/executions${query}`);
  const body = (await response.json()) as { items: ExecutionSummary[] };
  return { status: response.status, items: body.items };
}

/** The dispatch loop ticks every 200ms (events/dispatch-loop.ts); publishing
 * is fire-and-forget from the caller's point of view, so tests poll the
 * Local API itself — the same surface under test — until the expected
 * Execution count lands. */
async function waitForExecutionCount(
  engine: Harness,
  projectId: string,
  count: number,
  timeoutMs = 5_000,
): Promise<ExecutionSummary[]> {
  const startedAt = Date.now();
  for (;;) {
    const { items } = await getExecutions(engine, projectId);
    if (items.length >= count) return items;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `executions for project ${projectId} did not reach ${count} within ${timeoutMs}ms ` +
          `(last saw ${items.length})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The probe handler's echoed "pong" (sample-probe-module.ts) is published
 * through the Outbox and has no consumer, so it is only journaled on the
 * dispatch loop tick *after* the one that consumed its "ping" — reaching the
 * expected Execution count is not enough to guarantee the pong has landed
 * in `events` yet. Tests that assert on the full Event list wait for it
 * explicitly instead of assuming one poll suffices. */
async function waitForEventCount(
  engine: Harness,
  projectId: string,
  count: number,
  timeoutMs = 5_000,
): Promise<EventSummary[]> {
  const startedAt = Date.now();
  for (;;) {
    const { items } = await getEvents(engine, projectId);
    if (items.length >= count) return items;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `events for project ${projectId} did not reach ${count} within ${timeoutMs}ms ` +
          `(last saw ${items.length})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("durable event and execution timeline", () => {
  const engines: Harness[] = [];
  let validateEvent: ReturnType<typeof localApiValidator>;
  let validateExecution: ReturnType<typeof localApiValidator>;

  beforeAll(() => {
    validateEvent = localApiValidator("EventSummary");
    validateExecution = localApiValidator("ExecutionSummary");
  });

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  });

  async function setupEngine(): Promise<Harness> {
    const engine = await startEngine({
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);
    return engine;
  }

  it("carries kind, type, version, producer, subject, occurrence, correlation and causation", async () => {
    const engine = await setupEngine();
    await seedProject(engine, "proj-content");

    const published = await publishPing(engine, "proj-content", "corr_content", "work-item/1");
    expect(published.status).toBe(201);

    await waitForExecutionCount(engine, "proj-content", 1);
    const items = await waitForEventCount(engine, "proj-content", 2);
    const { status } = await getEvents(engine, "proj-content");
    expect(status).toBe(200);
    expect(items).toHaveLength(2);

    for (const item of items) {
      expect(validateEvent(item), explain(validateEvent)).toBe(true);
    }

    const ping = items.find((item) => item.type === SAMPLE_PROBE_PINGED.type);
    const pong = items.find((item) => item.type === SAMPLE_PROBE_PONGED.type);
    if (ping === undefined || pong === undefined) throw new Error("expected a ping and a pong");

    expect(ping).toMatchObject({
      version: SAMPLE_PROBE_PINGED.version,
      kind: "fact",
      producer: "github",
      correlationId: "corr_content",
      causationId: null,
      subjectRef: "work-item/1",
    });
    expect(new Date(ping.occurredAt).toISOString()).toBe(ping.occurredAt);

    // The probe handler echoes a caused fact (sample-probe-module.ts): the
    // causation/correlation chain is a pipeline guarantee, not per-handler
    // discipline (delivery-consumer.ts's `buildContext`).
    expect(pong).toMatchObject({
      version: SAMPLE_PROBE_PONGED.version,
      kind: "fact",
      producer: "probe-1",
      correlationId: "corr_content",
      causationId: ping.id,
      subjectRef: "work-item/1",
    });
  });

  it("orders Events newest first and truncates that order with limit", async () => {
    const engine = await setupEngine();
    await seedProject(engine, "proj-order");

    const first = await publishPing(engine, "proj-order", "corr_order_1", "work-item/1");
    expect(first.status).toBe(201);
    await waitForExecutionCount(engine, "proj-order", 1);
    const second = await publishPing(engine, "proj-order", "corr_order_2", "work-item/2");
    expect(second.status).toBe(201);
    await waitForExecutionCount(engine, "proj-order", 2);

    const items = await waitForEventCount(engine, "proj-order", 4);
    expect(items).toHaveLength(4);

    // Newest first: strictly non-increasing occurredAt across the whole list.
    for (let i = 1; i < items.length; i += 1) {
      expect(items[i - 1]!.occurredAt >= items[i]!.occurredAt).toBe(true);
    }
    // The second ping/pong pair happened after the first pair's, so it leads.
    expect(items.map((item) => item.correlationId)).toEqual([
      "corr_order_2",
      "corr_order_2",
      "corr_order_1",
      "corr_order_1",
    ]);

    const truncated = await getEvents(engine, "proj-order", "?limit=2");
    expect(truncated.items).toEqual(items.slice(0, 2));

    // Out of the contract's declared 1..500 bound: a client error, not a
    // silent clamp.
    const zero = await getEvents(engine, "proj-order", "?limit=0");
    expect(zero.status).toBe(400);
    const tooMany = await getEvents(engine, "proj-order", "?limit=501");
    expect(tooMany.status).toBe(400);
  });

  it("filters by correlationId and returns an empty list for an unknown chain", async () => {
    const engine = await setupEngine();
    await seedProject(engine, "proj-filter");
    await publishPing(engine, "proj-filter", "corr_filter_a", "work-item/a");
    await waitForExecutionCount(engine, "proj-filter", 1);
    await publishPing(engine, "proj-filter", "corr_filter_b", "work-item/b");
    await waitForExecutionCount(engine, "proj-filter", 2);

    const filtered = await getEvents(engine, "proj-filter", "?correlationId=corr_filter_a");
    expect(filtered.items).toHaveLength(2);
    expect(filtered.items.every((item) => item.correlationId === "corr_filter_a")).toBe(true);

    const unknown = await getEvents(engine, "proj-filter", "?correlationId=corr_does_not_exist");
    expect(unknown.status).toBe(200);
    expect(unknown.items).toEqual([]);
  });

  it("keeps two Projects' Events and Executions isolated", async () => {
    const engine = await setupEngine();
    await seedProject(engine, "proj-a");
    await seedProject(engine, "proj-b");

    await publishPing(engine, "proj-a", "corr_a_only", "work-item/a");
    await waitForExecutionCount(engine, "proj-a", 1);

    const eventsA = await getEvents(engine, "proj-a");
    const executionsA = await getExecutions(engine, "proj-a");
    expect(eventsA.items.length).toBeGreaterThan(0);
    expect(executionsA.items.length).toBeGreaterThan(0);

    const eventsB = await getEvents(engine, "proj-b");
    const executionsB = await getExecutions(engine, "proj-b");
    expect(eventsB.items).toEqual([]);
    expect(executionsB.items).toEqual([]);
  });

  it("reports Execution state, attempt, Module Instance and timestamps, linked to its input Event", async () => {
    const engine = await setupEngine();
    await seedProject(engine, "proj-link", "probe-linked");
    await publishPing(engine, "proj-link", "corr_link", "work-item/link");

    const executions = await waitForExecutionCount(engine, "proj-link", 1);
    expect(executions).toHaveLength(1);
    for (const item of executions) {
      expect(validateExecution(item), explain(validateExecution)).toBe(true);
    }

    const { items: events } = await getEvents(engine, "proj-link");
    const ping = events.find((event) => event.type === SAMPLE_PROBE_PINGED.type);
    if (ping === undefined) throw new Error("expected the ping event to be journaled");

    expect(executions[0]).toMatchObject({
      projectId: "proj-link",
      moduleInstanceId: "probe-linked",
      status: "completed",
      attempt: 1,
      inputEventId: ping.id,
      correlationId: "corr_link",
    });
    expect(executions[0]!.completedAt).not.toBeNull();
  });

  it("rejects a repeated correlationId query parameter instead of silently dropping the filter", async () => {
    const engine = await setupEngine();
    await seedProject(engine, "proj-repeated-correlation");
    await publishPing(engine, "proj-repeated-correlation", "corr_repeated_a", "work-item/a");
    await waitForExecutionCount(engine, "proj-repeated-correlation", 1);

    // Fastify parses a repeated query key as an array; `correlationId` must
    // then fail closed with the documented 400, never silently drop the
    // filter and return the whole Project journal (issue #59 code review,
    // finding 4).
    const response = await engine.call(
      "/v1/projects/proj-repeated-correlation/events?correlationId=a&correlationId=b",
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("api.invalid-request");
  });

  it("bounds /executions with the same limit contract as /events", async () => {
    const engine = await setupEngine();
    await seedProject(engine, "proj-executions-limit");
    await publishPing(engine, "proj-executions-limit", "corr_exec_limit_1", "work-item/1");
    await waitForExecutionCount(engine, "proj-executions-limit", 1);
    await publishPing(engine, "proj-executions-limit", "corr_exec_limit_2", "work-item/2");
    const all = await waitForExecutionCount(engine, "proj-executions-limit", 2);

    const truncated = await getExecutions(engine, "proj-executions-limit", "?limit=1");
    expect(truncated.items).toEqual(all.slice(0, 1));

    // Out of the contract's declared 1..500 bound: a client error, not an
    // unbounded read of the Ledger (issue #59 code review, finding 1).
    const zero = await getExecutions(engine, "proj-executions-limit", "?limit=0");
    expect(zero.status).toBe(400);
    const tooMany = await getExecutions(engine, "proj-executions-limit", "?limit=501");
    expect(tooMany.status).toBe(400);
  });
});
