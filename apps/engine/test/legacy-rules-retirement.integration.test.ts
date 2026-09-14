import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import {
  startReferenceWorkflowFixture,
  type ReferenceWorkflowFixture,
} from "./reference-workflow-fixture.js";

const fixtures: ReferenceWorkflowFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

it("keeps a legacy project readable while blocking polling and delivery replay", async () => {
  const fixture = await startReferenceWorkflowFixture(
    "legacy-rules-retirement",
    {},
    false,
    false,
    false,
  );
  fixtures.push(fixture);

  const beforeRestart = fixture.fakeGitHub.requests.length;
  const database = new Database(`${fixture.engine.dataRoot}/jarvis.sqlite`);
  database.prepare("UPDATE projects SET status = 'active' WHERE id = ?").run(fixture.projectId);
  database.close();
  await fixture.restart();

  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(fixture.fakeGitHub.requests.length).toBe(beforeRestart);

  const eventId = "legacy-rules-retirement-event";
  const deliveryId = "legacy-rules-retirement-delivery";
  const recordedAt = "2026-09-14T00:00:00.000Z";
  const envelope = {
    id: eventId,
    type: "scm.work-item.tag-added",
    version: 1,
    kind: "fact",
    projectId: fixture.projectId,
    repositoryId: "main",
    producer: { moduleId: "jarvis.module.github", moduleInstanceId: "github" },
    subject: { type: "work-item", ref: "github://Gasppacho/jarvis/issues/233" },
    correlationId: "corr_legacy_rules_retirement",
    causationId: null,
    payload: { workItemRef: "github://Gasppacho/jarvis/issues/233", tag: "ready-for-agent" },
  } as const;
  const history = new Database(`${fixture.engine.dataRoot}/jarvis.sqlite`);
  history.transaction(() => {
    history
      .prepare(
        `INSERT INTO events
           (id, project_id, type, version, kind, envelope, occurred_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        fixture.projectId,
        envelope.type,
        envelope.version,
        envelope.kind,
        JSON.stringify(envelope),
        recordedAt,
        recordedAt,
      );
    history
      .prepare(
        `INSERT INTO deliveries
           (id, project_id, event_id, module_instance_id, module_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        deliveryId,
        fixture.projectId,
        eventId,
        "automation-rules",
        "jarvis.module.automation-rules",
        recordedAt,
      );
  })();
  history.close();

  const replay = await fixture.engine.call("/test/redeliver", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: fixture.projectId,
      moduleInstanceId: "automation-rules",
      moduleId: "jarvis.module.automation-rules",
      eventId,
    }),
  });
  const replayBody = (await replay.json()) as {
    error: { code: string; message: string };
  };
  expect(replay.status).toBe(409);
  expect(replayBody.error).toMatchObject({
    code: "project.activation-not-validated",
    message:
      "Automation Rules deliveries remain preserved for history but cannot be executed or replayed after L13.",
  });

  const preserved = new Database(`${fixture.engine.dataRoot}/jarvis.sqlite`, { readonly: true });
  expect(
    preserved.prepare("SELECT id, envelope FROM events WHERE id = ?").get(eventId),
  ).toMatchObject({ id: eventId, envelope: JSON.stringify(envelope) });
  expect(
    preserved
      .prepare(
        "SELECT id, event_id, module_id, consumed_at, attempt_count FROM deliveries WHERE id = ?",
      )
      .get(deliveryId),
  ).toEqual({
    id: deliveryId,
    event_id: eventId,
    module_id: "jarvis.module.automation-rules",
    consumed_at: null,
    attempt_count: 0,
  });
  preserved.close();

  const detail = await fixture.engine.call(`/v1/projects/${fixture.projectId}`);
  expect(detail.status).toBe(200);
  const body = (await detail.json()) as {
    portableConfig: { modules: readonly { moduleId: string }[] };
  };
  expect(
    body.portableConfig.modules.some(
      (module) => module.moduleId === "jarvis.module.automation-rules",
    ),
  ).toBe(true);

  const overview = await fixture.engine.call(`/v1/projects/${fixture.projectId}/overview`);
  expect(overview.status).toBe(200);
  expect((await overview.json()) as { readinessHelp: string }).toMatchObject({
    readinessHelp: expect.stringContaining("exportable"),
  });
});
