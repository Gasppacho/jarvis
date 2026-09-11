import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine, type Harness } from "./harness.js";

const testBundlePath = fileURLToPath(
  new URL("../../../dist/engine/engine.test-bundle.mjs", import.meta.url),
);
const engines: Harness[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
});

describe("dead-letter Local API", () => {
  it("lists only the requested Project's dead letters newest first", async () => {
    const engine = await startEngine({
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);

    await createProject(engine, "dead-letter-a");
    await createProject(engine, "dead-letter-b");
    await failEvent(engine, "dead-letter-a", "first");
    await failEvent(engine, "dead-letter-a", "second");
    await failEvent(engine, "dead-letter-b", "other-project");

    const listed = await engine.call("/v1/projects/dead-letter-a/dead-letters");
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      readonly items: readonly DeadLetterItem[];
    };
    expect(body.items).toHaveLength(2);
    expect(body.items.every((item) => item.projectId === "dead-letter-a")).toBe(true);
    expect(body.items[0]!.createdAt >= body.items[1]!.createdAt).toBe(true);
    expect(body.items[0]).toMatchObject({
      projectId: "dead-letter-a",
      moduleInstanceId: "probe-1",
      code: "sample-probe.deterministic-failure",
      attempts: 1,
    });
    expect(body.items[0]).toHaveProperty("deliveryId");
    expect(body.items[0]).toHaveProperty("eventId");
    expect(body.items[0]).toHaveProperty("createdAt");

    const other = await engine.call("/v1/projects/dead-letter-b/dead-letters");
    expect(other.status).toBe(200);
    expect((await other.json()) as { items: readonly unknown[] }).toEqual({
      items: [expect.anything()],
    });

    const unknown = await engine.call("/v1/projects/missing/dead-letters");
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      "project.not-found",
    );

    const unauthenticated = await engine.callUnauthenticated(
      "/v1/projects/dead-letter-a/dead-letters",
    );
    expect(unauthenticated.status).toBe(401);
  });

  it("returns an empty list for a Project without dead letters", async () => {
    const engine = await startEngine({
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);
    await createProject(engine, "no-dead-letters");

    const response = await engine.call("/v1/projects/no-dead-letters/dead-letters");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
  });

  it("replays a listed Dead Letter through the authenticated Local API", async () => {
    const engine = await startEngine({
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);
    await createProject(engine, "replay-project");
    await failEvent(engine, "replay-project", "replay-me");

    const listed = await engine.call("/v1/projects/replay-project/dead-letters");
    const body = (await listed.json()) as { readonly items: readonly DeadLetterItem[] };
    const deliveryId = body.items[0]!.deliveryId;
    const replay = await engine.call(`/v1/dead-letters/${encodeURIComponent(deliveryId)}/replay`, {
      method: "POST",
    });
    expect(replay.status, await replay.clone().text()).toBe(202);
    expect(await replay.json()).toMatchObject({
      status: "failed",
      attempt: 2,
      inputEventId: body.items[0]!.eventId,
    });

    const afterReplay = await engine.call("/v1/projects/replay-project/dead-letters");
    expect((await afterReplay.json()) as { items: readonly DeadLetterItem[] }).toMatchObject({
      items: [expect.objectContaining({ attempts: 2 })],
    });

    const unknown = await engine.call("/v1/dead-letters/missing-delivery/replay", {
      method: "POST",
    });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      "delivery.not-found",
    );
    const unauthenticated = await engine.callUnauthenticated(
      `/v1/dead-letters/${encodeURIComponent(deliveryId)}/replay`,
      { method: "POST" },
    );
    expect(unauthenticated.status).toBe(401);
  });
});

async function createProject(engine: Harness, id: string): Promise<void> {
  const response = await engine.call("/test/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
}

async function failEvent(engine: Harness, projectId: string, subject: string): Promise<void> {
  const response = await engine.call("/test/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "sample.probe.pinged",
      version: 1,
      kind: "fact",
      projectId,
      producer: { moduleId: "jarvis.module.github", moduleInstanceId: "github" },
      subject: { type: "work-item", ref: `github://${projectId}/${subject}` },
      correlationId: `corr_${projectId}_${subject}`,
      causationId: null,
      payload: { shouldFail: true },
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const event = (await response.json()) as { readonly id: string };
  await engine.waitForStderr(`event=${event.id} status=failed`);
}

interface DeadLetterItem {
  readonly deliveryId: string;
  readonly projectId: string;
  readonly eventId: string;
  readonly moduleInstanceId: string;
  readonly code: string;
  readonly message?: string;
  readonly attempts: number;
  readonly createdAt: string;
}
