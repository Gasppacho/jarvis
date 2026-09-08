import Database from "better-sqlite3";
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

async function waitForEvents(
  engine: Harness,
  projectId: string,
  count: number,
  timeoutMs = 5_000,
): Promise<readonly Record<string, unknown>[]> {
  const startedAt = Date.now();
  for (;;) {
    const response = await engine.call(`/v1/projects/${projectId}/events`);
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { readonly items: readonly Record<string, unknown>[] };
    if (body.items.length >= count) return body.items;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`project ${projectId} did not reach ${count} events`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForExecutions(
  engine: Harness,
  projectId: string,
  count: number,
  timeoutMs = 5_000,
): Promise<readonly Record<string, unknown>[]> {
  const startedAt = Date.now();
  for (;;) {
    const response = await engine.call(`/v1/projects/${projectId}/executions`);
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { readonly items: readonly Record<string, unknown>[] };
    if (body.items.length >= count) return body.items;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`project ${projectId} did not reach ${count} executions`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function tagAddedInput(projectId: string, tag: string, correlationId: string) {
  return {
    type: "scm.work-item.tag-added",
    version: 1,
    kind: "fact" as const,
    projectId,
    producer: { moduleId: "jarvis.module.github", moduleInstanceId: "github" },
    subject: { type: "work-item", ref: `github://acme/${projectId}/issues/8` },
    repositoryId: "main",
    correlationId,
    causationId: null,
    payload: {
      workItemRef: `github://acme/${projectId}/issues/8`,
      tag,
    },
  };
}

function implementationRequestInput(projectId: string, correlationId: string) {
  return {
    type: "development.implementation.requested",
    version: 1,
    kind: "request" as const,
    projectId,
    producer: {
      moduleId: "jarvis.module.automation-rules",
      moduleInstanceId: "automation-rules",
    },
    subject: { type: "work-item", ref: `github://acme/${projectId}/issues/64` },
    repositoryId: "main",
    correlationId,
    causationId: null,
    target: { moduleInstanceId: "missing-worker" },
    idempotencyKey: `${projectId}:missing-target`,
    payload: {
      workItemRef: `github://acme/${projectId}/issues/64`,
      repositoryId: "main",
      baseBranch: "main",
    },
  };
}

describe("Automation Rules Application Harness", () => {
  it("matches once, leaves no-match auditable, routes its request, and stays project-scoped", async () => {
    const engine = await startEngine({
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);

    for (const [projectId, targetMode, ruleTag] of [
      ["project-a", "binding", "agent:ready"],
      ["project-b", "direct", "agent:ready"],
      ["project-c", "binding", "agent:other"],
    ] as const) {
      const response = await engine.call("/test/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: projectId, kind: "automation", targetMode, ruleTag }),
      });
      expect(response.status).toBe(201);
    }

    const matchingResponse = await engine.call("/test/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tagAddedInput("project-a", "agent:ready", "corr_automation_project_a")),
    });
    expect(matchingResponse.status).toBe(201);
    const matchingEvent = (await matchingResponse.json()) as { readonly id: string };

    const directMatchingResponse = await engine.call("/test/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tagAddedInput("project-b", "agent:ready", "corr_automation_project_b")),
    });
    expect(directMatchingResponse.status).toBe(201);

    const unmatchedResponse = await engine.call("/test/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tagAddedInput("project-c", "agent:ready", "corr_automation_project_c")),
    });
    expect(unmatchedResponse.status).toBe(201);

    const projectAEvents = await waitForEvents(engine, "project-a", 2);
    const projectBEvents = await waitForEvents(engine, "project-b", 2);
    const projectCEvents = await waitForEvents(engine, "project-c", 1);
    const projectAExecutions = await waitForExecutions(engine, "project-a", 1);
    const projectBExecutions = await waitForExecutions(engine, "project-b", 1);
    const requests = (events: readonly Record<string, unknown>[]) =>
      events.filter(
        (event) =>
          event["type"] === "development.implementation.requested" && event["kind"] === "request",
      );

    expect(requests(projectAEvents)).toHaveLength(1);
    expect(requests(projectBEvents)).toHaveLength(1);
    expect(projectCEvents).toHaveLength(1);
    expect(projectBEvents.find((event) => event["kind"] === "fact")).toMatchObject({
      ["type"]: "scm.work-item.tag-added",
      ["kind"]: "fact",
      ["correlationId"]: "corr_automation_project_b",
      ["causationId"]: null,
    });
    expect(projectCEvents[0]).toMatchObject({
      ["type"]: "scm.work-item.tag-added",
      ["kind"]: "fact",
      ["correlationId"]: "corr_automation_project_c",
      ["causationId"]: null,
    });
    expect(
      projectAExecutions.filter((execution) => execution["moduleInstanceId"] === "request-worker"),
    ).toEqual([
      expect.objectContaining({ moduleInstanceId: "request-worker", status: "completed" }),
    ]);
    expect(
      projectBExecutions.filter((execution) => execution["moduleInstanceId"] === "request-worker"),
    ).toEqual([
      expect.objectContaining({ moduleInstanceId: "request-worker", status: "completed" }),
    ]);

    const database = new Database(`${engine.dataRoot}/jarvis.sqlite`);
    try {
      const requestRow = database
        .prepare(
          "SELECT id, envelope FROM events WHERE project_id = ? AND kind = 'request' AND type = ?",
        )
        .get("project-a", "development.implementation.requested") as
        { readonly id: string; readonly envelope: string } | undefined;
      expect(requestRow).toBeDefined();
      if (requestRow === undefined) throw new Error("project-a request was not journaled");
      expect(JSON.parse(requestRow.envelope)).toMatchObject({
        projectId: "project-a",
        correlationId: "corr_automation_project_a",
        causationId: matchingEvent.id,
        target: { binding: "implementation" },
      });

      const redeliveryResponse = await engine.call("/test/redeliver", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "project-a",
          moduleInstanceId: "request-worker",
          moduleId: "jarvis.module.test-request-worker",
          eventId: requestRow.id,
        }),
      });
      expect(redeliveryResponse.status).toBe(200);
      expect(await redeliveryResponse.json()).toMatchObject({
        redelivered: true,
        status: "completed",
        executionId: null,
      });

      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM deliveries WHERE project_id = ? AND event_id = ?")
          .get("project-a", requestRow.id),
      ).toEqual({ count: 1 });
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM executions WHERE project_id = ? AND module_instance_id = ? AND input_event_id = ?",
          )
          .get("project-a", "request-worker", requestRow.id),
      ).toEqual({ count: 1 });

      expect(
        database
          .prepare(
            `SELECT module_instance_id, module_id
             FROM deliveries
             WHERE project_id = ? AND event_id = (
               SELECT id FROM events
               WHERE project_id = ? AND kind = 'request'
                 AND type = 'development.implementation.requested'
             )`,
          )
          .all("project-a", "project-a"),
      ).toEqual([
        { module_instance_id: "request-worker", module_id: "jarvis.module.test-request-worker" },
      ]);

      const projectBRequest = database
        .prepare(
          "SELECT envelope FROM events WHERE project_id = ? AND kind = 'request' AND type = ?",
        )
        .get("project-b", "development.implementation.requested") as
        { readonly envelope: string } | undefined;
      expect(projectBRequest).toBeDefined();
      expect(JSON.parse(projectBRequest?.envelope ?? "{}")).toMatchObject({
        projectId: "project-b",
        correlationId: "corr_automation_project_b",
        target: { moduleInstanceId: "request-worker" },
      });

      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM events WHERE project_id = ? AND kind = 'request'")
          .get("project-c"),
      ).toEqual({ count: 0 });

      const missingTargetResponse = await engine.call("/test/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          implementationRequestInput("project-a", "corr_automation_missing_target"),
        ),
      });
      expect(missingTargetResponse.status).toBe(201);
      const missingTargetEvent = (await missingTargetResponse.json()) as { readonly id: string };
      await engine.waitForStderr("request-consumer-not-found");

      // Invalid Request routing is logged and remains pending atomically:
      // there is no journal entry or Delivery to acknowledge.
      expect(
        database.prepare("SELECT id FROM events WHERE id = ?").get(missingTargetEvent.id),
      ).toBeUndefined();
      expect(
        database.prepare("SELECT status FROM outbox WHERE event_id = ?").get(missingTargetEvent.id),
      ).toEqual({ status: "pending" });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM deliveries WHERE event_id = ?")
          .get(missingTargetEvent.id),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
