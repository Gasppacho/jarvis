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
