import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { explain, localApiValidator } from "./contract.js";
import { startEngine, type Harness, type SseConnection } from "./harness.js";
import { SAMPLE_PROBE_PINGED } from "../src/executions/sample-probe-module.js";

/**
 * Ticket #60 (issue #60 "Test seam"): Application Harness — start the real
 * engine with the durability test hooks (#59's `timeline.integration.test.ts`
 * is the closest precedent), open `GET /v1/stream`, and publish the same
 * "ping" fact that fixture already uses to produce a journaled Event fanning
 * out to one Execution, plus a caused "pong" Event with zero consumers.
 * Every ping therefore yields exactly three durable rows — `event.recorded`
 * (ping), `execution.changed`, `event.recorded` (pong) — which is what this
 * suite's message counts assume throughout.
 */
const testBundlePath = fileURLToPath(
  new URL("../../../dist/engine/engine.test-bundle.mjs", import.meta.url),
);

interface StreamMessage {
  readonly sequence: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly projectId: string | null;
  readonly sessionId?: string;
  readonly payload: Record<string, unknown>;
}

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

async function getEvents(engine: Harness, projectId: string): Promise<EventSummary[]> {
  const response = await engine.call(`/v1/projects/${projectId}/events`);
  const body = (await response.json()) as { items: EventSummary[] };
  return body.items;
}

async function getExecutions(engine: Harness, projectId: string): Promise<ExecutionSummary[]> {
  const response = await engine.call(`/v1/projects/${projectId}/executions`);
  const body = (await response.json()) as { items: ExecutionSummary[] };
  return body.items;
}

async function waitForExecutionCount(
  engine: Harness,
  projectId: string,
  count: number,
  timeoutMs = 5_000,
): Promise<ExecutionSummary[]> {
  const startedAt = Date.now();
  for (;;) {
    const items = await getExecutions(engine, projectId);
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

/** The probe handler's echoed "pong" is only journaled on the dispatch
 * loop's tick *after* the one that consumed its "ping" (same fixture
 * behavior `timeline.integration.test.ts` documents), so reaching the
 * expected Execution count is not enough to know the pong has landed yet. */
async function waitForEventCount(
  engine: Harness,
  projectId: string,
  count: number,
  timeoutMs = 5_000,
): Promise<EventSummary[]> {
  const startedAt = Date.now();
  for (;;) {
    const items = await getEvents(engine, projectId);
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

async function waitForStatus(stream: SseConnection, timeoutMs = 5_000): Promise<number> {
  const startedAt = Date.now();
  for (;;) {
    const status = stream.status();
    if (status !== undefined) return status;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("SSE stream never received a response status.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Strips identity/time fields so two independently-timed runs can be
 * compared for the acceptance criterion "durable state is unaffected by a
 * connected client" without pretending real wall-clock timestamps from two
 * different moments can be byte-equal. */
function normalizeEvents(items: readonly EventSummary[]) {
  return items
    .map((item) => ({
      type: item.type,
      version: item.version,
      kind: item.kind,
      producer: item.producer,
      subjectRef: item.subjectRef,
    }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

function normalizeExecutions(items: readonly ExecutionSummary[]) {
  return items.map((item) => ({
    moduleInstanceId: item.moduleInstanceId,
    status: item.status,
    attempt: item.attempt,
  }));
}

describe("GET /v1/stream", () => {
  const engines: Harness[] = [];
  const extraCleanups: (() => Promise<void>)[] = [];
  let validateMessage: ReturnType<typeof localApiValidator>;
  let validateEvent: ReturnType<typeof localApiValidator>;
  let validateExecution: ReturnType<typeof localApiValidator>;

  beforeAll(() => {
    validateMessage = localApiValidator("StreamMessage");
    validateEvent = localApiValidator("EventSummary");
    validateExecution = localApiValidator("ExecutionSummary");
  });

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
    await Promise.all(extraCleanups.splice(0).map((cleanup) => cleanup()));
  });

  function expectValidMessages(messages: readonly unknown[]): asserts messages is StreamMessage[] {
    for (const message of messages) {
      expect(validateMessage(message), explain(validateMessage)).toBe(true);
    }
  }

  async function setupEngine(options: Parameters<typeof startEngine>[0] = {}): Promise<Harness> {
    const engine = await startEngine({
      enginePath: testBundlePath,
      ...options,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1", ...options.env },
    });
    engines.push(engine);
    return engine;
  }

  it("refuses an unauthenticated call and a non-loopback call before any stream is opened", async () => {
    const engine = await setupEngine();

    const unauthenticated = await engine.callRaw("/v1/stream", {});
    expect(unauthenticated.status).toBe(401);

    const nonLoopback = await engine.callRaw("/v1/stream", {
      host: "jarvis.example.com",
      authorization: `Bearer ${engine.token}`,
    });
    expect(nonLoopback.status).toBe(403);
  });

  it("answers with the correlation id header every other operation carries", async () => {
    const engine = await setupEngine();
    const stream = engine.openStream();
    expect(await waitForStatus(stream)).toBe(200);

    // The handler hijacks the reply and writes its own head, so the header
    // the global onRequest hook set is only on the wire if the handler put it
    // there. Without it this is the one operation an operator cannot
    // correlate against engine logs.
    expect(stream.headers()?.["x-jarvis-correlation-id"]).toMatch(/\S/);

    stream.close();
  });

  it("carries the same summary content the REST timeline serves, tagged with Project and Engine Session", async () => {
    const engine = await setupEngine();
    await seedProject(engine, "proj-live");
    const stream = engine.openStream();
    expect(await waitForStatus(stream)).toBe(200);

    const published = await publishPing(engine, "proj-live", "corr_live", "work-item/1");
    expect(published.status).toBe(201);

    const messages = await stream.waitForCount(3);
    expectValidMessages(messages);

    for (const message of messages) {
      expect(message.projectId).toBe("proj-live");
      expect(message.sessionId).toBe(engine.handshake.sessionId);
    }

    const eventMessages = messages.filter((message) => message.type === "event.recorded");
    const executionMessages = messages.filter((message) => message.type === "execution.changed");
    expect(eventMessages).toHaveLength(2);
    expect(executionMessages).toHaveLength(1);

    const pingMessage = eventMessages.find(
      (message) => (message.payload as unknown as EventSummary).type === SAMPLE_PROBE_PINGED.type,
    );
    if (pingMessage === undefined) throw new Error("expected a ping event.recorded message");
    expect(validateEvent(pingMessage.payload), explain(validateEvent)).toBe(true);
    expect(pingMessage.payload).toMatchObject({
      correlationId: "corr_live",
      causationId: null,
      subjectRef: "work-item/1",
    });

    const executionMessage = executionMessages[0]!;
    expect(validateExecution(executionMessage.payload), explain(validateExecution)).toBe(true);

    // Byte-identical to what the REST timeline serves for the very same row.
    const restExecutions = await waitForExecutionCount(engine, "proj-live", 1);
    expect(executionMessage.payload).toEqual(restExecutions[0]);
    const restEvents = await getEvents(engine, "proj-live");
    const restPing = restEvents.find((event) => event.type === SAMPLE_PROBE_PINGED.type);
    expect(pingMessage.payload).toEqual(restPing);

    stream.close();
  });

  it("increases sequence monotonically without gaps across message types and Projects", async () => {
    const engine = await setupEngine();
    await seedProject(engine, "proj-seq-a");
    await seedProject(engine, "proj-seq-b");
    const stream = engine.openStream();
    expect(await waitForStatus(stream)).toBe(200);

    await publishPing(engine, "proj-seq-a", "corr_seq_a", "work-item/a");
    await publishPing(engine, "proj-seq-b", "corr_seq_b", "work-item/b");

    const messages = await stream.waitForCount(6);
    expectValidMessages(messages);

    const sequences = messages.map((message) => message.sequence);
    expect(sequences[0]).toBe(1);
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i]).toBe(sequences[i - 1]! + 1);
    }

    stream.close();
  });

  it("fans out to two concurrent clients, and one disconnecting does not disturb the other", async () => {
    const engine = await setupEngine();
    await seedProject(engine, "proj-fanout");
    const clientA = engine.openStream();
    const clientB = engine.openStream();
    expect(await waitForStatus(clientA)).toBe(200);
    expect(await waitForStatus(clientB)).toBe(200);

    await publishPing(engine, "proj-fanout", "corr_fanout_1", "work-item/1");
    await clientA.waitForCount(3);
    await clientB.waitForCount(3);
    expect(clientA.messages).toEqual(clientB.messages);

    clientA.close();
    await clientA.waitForClose();

    await publishPing(engine, "proj-fanout", "corr_fanout_2", "work-item/2");
    await clientB.waitForCount(6);
    // The disconnected client never grew past what it had already received.
    expect(clientA.messages).toHaveLength(3);

    const health = await engine.call("/v1/health");
    expect(health.status).toBe(200);

    clientB.close();
  });

  it("leaves the journal, Ledger and REST timeline unaffected by whether a client is connected", async () => {
    const engine = await setupEngine();
    await seedProject(engine, "proj-no-client");
    await seedProject(engine, "proj-with-client");

    // Fully settled (ping, pong and Execution all landed) before the stream
    // ever connects, so nothing from this Project can land on it later and
    // pad the count the "with a client" side waits for below.
    await publishPing(engine, "proj-no-client", "corr_no_client", "work-item/x");
    await waitForExecutionCount(engine, "proj-no-client", 1);
    await waitForEventCount(engine, "proj-no-client", 2);

    const stream = engine.openStream();
    expect(await waitForStatus(stream)).toBe(200);
    await publishPing(engine, "proj-with-client", "corr_with_client", "work-item/x");
    await waitForExecutionCount(engine, "proj-with-client", 1);
    await waitForEventCount(engine, "proj-with-client", 2);

    const eventsNoClient = normalizeEvents(await getEvents(engine, "proj-no-client"));
    const eventsWithClient = normalizeEvents(await getEvents(engine, "proj-with-client"));
    expect(eventsWithClient).toEqual(eventsNoClient);

    const executionsNoClient = normalizeExecutions(await getExecutions(engine, "proj-no-client"));
    const executionsWithClient = normalizeExecutions(
      await getExecutions(engine, "proj-with-client"),
    );
    expect(executionsWithClient).toEqual(executionsNoClient);

    stream.close();
  });

  it("keeps dispatching and consuming after a client disconnects mid-stream", async () => {
    const engine = await setupEngine();
    await seedProject(engine, "proj-drop");
    const stream = engine.openStream();
    expect(await waitForStatus(stream)).toBe(200);

    await publishPing(engine, "proj-drop", "corr_drop_1", "work-item/1");
    await stream.waitForCount(1);
    stream.close();
    await stream.waitForClose();

    await publishPing(engine, "proj-drop", "corr_drop_2", "work-item/2");
    const executions = await waitForExecutionCount(engine, "proj-drop", 2);
    expect(executions).toHaveLength(2);
  });

  it("does not delay Engine shutdown while a stream is still open", async () => {
    const engine = await setupEngine();
    const stream = engine.openStream();
    expect(await waitForStatus(stream)).toBe(200);

    const startedAt = Date.now();
    const response = await engine.call("/v1/system/shutdown", { method: "POST" });
    expect(response.status).toBe(202);
    const exitCode = await engine.waitForExit();
    expect(exitCode).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("restarts sequence numbering at 1 with a different Engine Session after a restart", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "jarvis-stream-restart-"));
    extraCleanups.push(() => rm(dataRoot, { recursive: true, force: true }));

    const engine1 = await setupEngine({ dataRoot });
    await seedProject(engine1, "proj-restart");
    const stream1 = engine1.openStream();
    expect(await waitForStatus(stream1)).toBe(200);
    await publishPing(engine1, "proj-restart", "corr_restart_1", "work-item/1");
    const messages1 = await stream1.waitForCount(1);
    expectValidMessages(messages1);
    expect(messages1[0]!.sequence).toBe(1);
    const sessionId1 = engine1.handshake.sessionId;

    const shutdownResponse = await engine1.call("/v1/system/shutdown", { method: "POST" });
    expect(shutdownResponse.status).toBe(202);
    await engine1.waitForExit();

    const engine2 = await setupEngine({ dataRoot });
    const stream2 = engine2.openStream();
    expect(await waitForStatus(stream2)).toBe(200);
    await publishPing(engine2, "proj-restart", "corr_restart_2", "work-item/2");
    const messages2 = await stream2.waitForCount(1);
    expectValidMessages(messages2);
    expect(messages2[0]!.sequence).toBe(1);
    expect(engine2.handshake.sessionId).not.toBe(sessionId1);
  });
});
