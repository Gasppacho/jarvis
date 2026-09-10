import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine, type Harness } from "./harness.js";
import { SAMPLE_PROBE_PINGED } from "../src/executions/sample-probe-module.js";

const testBundlePath = fileURLToPath(
  new URL("../../../dist/engine/engine.test-bundle.mjs", import.meta.url),
);
const engines: Harness[] = [];
const dataRoots: string[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  await Promise.all(dataRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("External Mapping capability Application Harness", () => {
  it("persists attempts and resources across restart, scoped by project and Module Instance", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "jarvis-external-mapping-"));
    dataRoots.push(dataRoot);
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);

    await createProject(engine, "mapping-a", "probe-a");
    await createProject(engine, "mapping-b", "probe-b");

    const attempted = await publishPing(engine, "mapping-a", "probe-a", {
      action: "attempt",
      idempotencyKey: "same-key",
    });
    await waitForExecution(engine, "mapping-a", attempted.id);

    const completed = await publishPing(engine, "mapping-a", "probe-a", {
      action: "complete",
      idempotencyKey: "same-key",
      resourceRef: "github://acme/repo/pulls/7",
    });
    await waitForExecution(engine, "mapping-a", completed.id);

    const otherProject = await publishPing(engine, "mapping-b", "probe-b", {
      action: "attempt",
      idempotencyKey: "same-key",
    });
    await waitForExecution(engine, "mapping-b", otherProject.id);
    await engine.dispose();
    engines.splice(engines.indexOf(engine), 1);

    const restarted = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(restarted);
    const read = await publishPing(restarted, "mapping-a", "probe-a", {
      action: "read",
      idempotencyKey: "same-key",
    });
    await waitForExecution(restarted, "mapping-a", read.id);

    const database = new Database(join(dataRoot, "jarvis.sqlite"));
    try {
      expect(
        database
          .prepare(
            `SELECT project_id, module_instance_id, status, resource_ref
             FROM external_mappings ORDER BY project_id`,
          )
          .all(),
      ).toEqual([
        {
          project_id: "mapping-a",
          module_instance_id: "probe-a",
          status: "completed",
          resource_ref: "github://acme/repo/pulls/7",
        },
        {
          project_id: "mapping-b",
          module_instance_id: "probe-b",
          status: "attempted",
          resource_ref: null,
        },
      ]);

      expect(
        JSON.parse(
          (
            database
              .prepare("SELECT result FROM inbox WHERE event_id = ?")
              .get(read.id) as { readonly result: string }
          ).result,
        ),
      ).toMatchObject({
        externalMapping: {
          status: "completed",
          resourceRef: "github://acme/repo/pulls/7",
        },
      });
      expect(
        database
          .prepare("SELECT status FROM executions WHERE input_event_id = ?")
          .get(read.id),
      ).toEqual({ status: "completed" });
    } finally {
      database.close();
    }
  });
});

async function createProject(engine: Harness, id: string, moduleInstanceId: string): Promise<void> {
  const response = await engine.call("/test/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, moduleInstanceId }),
  });
  expect(response.status).toBe(201);
}

async function publishPing(
  engine: Harness,
  projectId: string,
  moduleInstanceId: string,
  externalMapping: Record<string, string>,
): Promise<{ readonly id: string }> {
  const response = await engine.call("/test/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: SAMPLE_PROBE_PINGED.type,
      version: SAMPLE_PROBE_PINGED.version,
      kind: SAMPLE_PROBE_PINGED.kind,
      projectId,
      producer: { moduleId: "jarvis.module.test", moduleInstanceId: "test" },
      subject: { type: "work-item", ref: `github://acme/${projectId}/issues/1` },
      correlationId: `corr_${projectId}_${moduleInstanceId}_${externalMapping.action}`,
      causationId: null,
      payload: { externalMapping },
    }),
  });
  if (response.status !== 201) throw new Error(`${response.status}: ${await response.text()}`);
  return (await response.json()) as { readonly id: string };
}

async function waitForExecution(
  engine: Harness,
  projectId: string,
  eventId: string,
  timeoutMs = 5_000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const response = await engine.call(`/v1/projects/${projectId}/executions`);
    expect(response.ok).toBe(true);
    const body = (await response.json()) as {
      readonly items: readonly {
        readonly inputEventId: string;
        readonly status: string;
      }[];
    };
    if (body.items.some((item) => item.inputEventId === eventId && item.status === "completed")) {
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`event ${eventId} did not complete for project ${projectId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
