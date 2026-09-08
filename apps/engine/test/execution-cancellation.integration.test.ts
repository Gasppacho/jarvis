import Database from "better-sqlite3";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SAMPLE_PROBE_PINGED } from "../src/executions/sample-probe-module.js";
import { explain, localApiValidator } from "./contract.js";
import { startEngine, type Harness } from "./harness.js";

const testBundlePath = fileURLToPath(
  new URL("../../../dist/engine/engine.test-bundle.mjs", import.meta.url),
);

interface ExecutionSummary {
  readonly id: string;
  readonly projectId: string;
  readonly moduleInstanceId: string;
  readonly status: string;
  readonly attempt: number;
  readonly createdAt: string;
  readonly completedAt?: string | null;
  readonly inputEventId?: string;
}

interface EventSummary {
  readonly id: string;
  readonly type: string;
}

const input = (projectId: string) => ({
  type: SAMPLE_PROBE_PINGED.type,
  version: SAMPLE_PROBE_PINGED.version,
  kind: SAMPLE_PROBE_PINGED.kind,
  projectId,
  producer: { moduleId: "jarvis.module.github", moduleInstanceId: "github" },
  subject: { type: "work-item", ref: `work-item/${projectId}` },
  correlationId: `corr_${projectId}`,
  causationId: null,
  payload: { waitForCancellation: true },
});

describe("execution cancellation Local API", () => {
  const engines: Harness[] = [];
  let validateExecution: ReturnType<typeof localApiValidator>;

  beforeAll(() => {
    validateExecution = localApiValidator("ExecutionSummary");
  });

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  });

  async function setup(): Promise<Harness> {
    const engine = await startEngine({
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);
    return engine;
  }

  it("returns the durable cancelling row, aborts the handler, and drops buffered publications", async () => {
    const engine = await setup();
    await seedProject(engine, "proj-cancel");
    const published = await publish(engine, "proj-cancel");
    const running = await waitForStatus(engine, "proj-cancel", "running");

    const response = await engine.call(`/v1/executions/${running.id}/cancel`, { method: "POST" });
    expect(response.status).toBe(202);
    const cancelling = (await response.json()) as ExecutionSummary;
    expect(validateExecution(cancelling), explain(validateExecution)).toBe(true);
    expect(cancelling).toMatchObject({
      id: running.id,
      projectId: "proj-cancel",
      status: "cancelling",
      inputEventId: published.id,
      completedAt: null,
    });

    const cancelled = await waitForStatus(engine, "proj-cancel", "cancelled", running.id);
    expect(cancelled.completedAt).not.toBeNull();

    const events = await getEvents(engine, "proj-cancel");
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(published.id);

    const database = new Database(join(engine.dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(database.prepare("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 1 });
      expect(database.prepare("SELECT status FROM inbox").get()).toEqual({ status: "cancelled" });
      expect(database.prepare("SELECT consumed_at FROM deliveries").get()).not.toEqual({
        consumed_at: null,
      });
    } finally {
      database.close();
    }

    const repeated = await engine.call(`/v1/executions/${running.id}/cancel`, { method: "POST" });
    expect(repeated.status).toBe(409);
    expect((await repeated.json()) as unknown).toMatchObject({
      error: { code: "execution.not-cancellable" },
    });
    expect((await getExecutions(engine, "proj-cancel"))[0]?.status).toBe("cancelled");

    const unknown = await engine.call("/v1/executions/exec_does_not_exist/cancel", {
      method: "POST",
    });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()) as unknown).toMatchObject({
      error: { code: "execution.not-found" },
    });
  });

  it("keeps cancellation scoped to the execution's Project", async () => {
    const engine = await setup();
    await seedProject(engine, "proj-cancel-a");
    await seedProject(engine, "proj-cancel-b");
    await publish(engine, "proj-cancel-a");
    await publish(engine, "proj-cancel-b");
    const runningA = await waitForStatus(engine, "proj-cancel-a", "running");

    const response = await engine.call(`/v1/executions/${runningA.id}/cancel`, { method: "POST" });
    expect(response.status).toBe(202);
    await waitForStatus(engine, "proj-cancel-a", "cancelled", runningA.id);
    const runningB = await waitForStatus(engine, "proj-cancel-b", "running");
    expect((await getExecutions(engine, "proj-cancel-b"))[0]).toMatchObject({
      id: runningB.id,
      projectId: "proj-cancel-b",
      status: "running",
    });

    const cleanup = await engine.call(`/v1/executions/${runningB.id}/cancel`, { method: "POST" });
    expect(cleanup.status).toBe(202);
    await waitForStatus(engine, "proj-cancel-b", "cancelled", runningB.id);
  });
});

async function seedProject(engine: Harness, id: string): Promise<void> {
  const response = await engine.call("/test/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  expect(response.status).toBe(201);
}

async function publish(engine: Harness, projectId: string): Promise<{ id: string }> {
  const response = await engine.call("/test/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input(projectId)),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

async function getExecutions(engine: Harness, projectId: string): Promise<ExecutionSummary[]> {
  const response = await engine.call(`/v1/projects/${projectId}/executions`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: ExecutionSummary[] }).items;
}

async function getEvents(engine: Harness, projectId: string): Promise<EventSummary[]> {
  const response = await engine.call(`/v1/projects/${projectId}/events`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: EventSummary[] }).items;
}

async function waitForStatus(
  engine: Harness,
  projectId: string,
  status: string,
  executionId?: string,
  timeoutMs = 5_000,
): Promise<ExecutionSummary> {
  const startedAt = Date.now();
  for (;;) {
    const executions = await getExecutions(engine, projectId);
    const execution = executions.find(
      (candidate) =>
        (executionId === undefined || candidate.id === executionId) && candidate.status === status,
    );
    if (execution !== undefined) return execution;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `execution for project ${projectId} did not reach ${status} within ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
