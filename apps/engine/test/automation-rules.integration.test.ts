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

describe("Automation Rules Application Harness", () => {
  it("matches once, leaves no-match auditable, routes its request, and stays project-scoped", async () => {
    const engine = await startEngine({
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);

    for (const projectId of ["project-a", "project-b"]) {
      const response = await engine.call("/test/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: projectId, kind: "automation" }),
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

    const unmatchedResponse = await engine.call("/test/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        tagAddedInput("project-b", "agent:not-ready", "corr_automation_project_b"),
      ),
    });
    expect(unmatchedResponse.status).toBe(201);

    const projectAEvents = await waitForEvents(engine, "project-a", 2);
    const projectBEvents = await waitForEvents(engine, "project-b", 1);
    const requests = projectAEvents.filter(
      (event) =>
        event["type"] === "development.implementation.requested" && event["kind"] === "request",
    );

    expect(requests).toHaveLength(1);
    expect(projectBEvents).toHaveLength(1);
    expect(projectBEvents[0]).toMatchObject({
      ["type"]: "scm.work-item.tag-added",
      ["kind"]: "fact",
      ["correlationId"]: "corr_automation_project_b",
      ["causationId"]: null,
    });

    const database = new Database(`${engine.dataRoot}/jarvis.sqlite`);
    try {
      const requestRow = database
        .prepare(
          "SELECT envelope FROM events WHERE project_id = ? AND kind = 'request' AND type = ?",
        )
        .get("project-a", "development.implementation.requested") as
        { readonly envelope: string } | undefined;
      expect(requestRow).toBeDefined();
      expect(JSON.parse(requestRow?.envelope ?? "{}")).toMatchObject({
        projectId: "project-a",
        correlationId: "corr_automation_project_a",
        causationId: matchingEvent.id,
        target: { binding: "implementation" },
      });

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
        { module_instance_id: "request-worker", module_id: "jarvis.test.request-worker" },
      ]);

      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM events WHERE project_id = ? AND kind = 'request'")
          .get("project-b"),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
