import { afterEach, expect, it } from "vitest";
import type { ProjectOverview } from "../src/projects/types.js";
import { explain, localApiValidator } from "./contract.js";
import {
  startReferenceWorkflowFixture,
  type ReferenceWorkflowFixture,
} from "./reference-workflow-fixture.js";

const fixtures: ReferenceWorkflowFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

function seedIssue(fixture: ReferenceWorkflowFixture, number: number, blockedBy = false): void {
  fixture.fakeGitHub.seedIssue({
    owner: "Gasppacho",
    repository: "jarvis",
    issue: {
      number,
      title: `Overview issue ${number}`,
      body: "A harmless fake issue",
      state: "open",
      labels: blockedBy ? [{ name: "ready-for-agent" }] : [],
      blockedBy: blockedBy
        ? [{ number: 99, title: "Open dependency", body: "", state: "open", labels: [] }]
        : [],
    },
  });
}

async function overview(fixture: ReferenceWorkflowFixture): Promise<ProjectOverview> {
  const response = await fixture.engine.call(`/v1/projects/${fixture.projectId}/overview`);
  expect(response.status).toBe(200);
  const body = await response.json();
  const validate = localApiValidator("ProjectOverviewV1");
  expect(validate(body), explain(validate)).toBe(true);
  return body as ProjectOverview;
}

it("exposes issue reasons, native blockers, last poll and a retained failed snapshot", async () => {
  const fixture = await startReferenceWorkflowFixture("overview");
  fixtures.push(fixture);
  seedIssue(fixture, 1);
  seedIssue(fixture, 2, true);

  const first = (await (
    await fixture.engine.call(`/v1/projects/${fixture.projectId}/overview/refresh`, {
      method: "POST",
    })
  ).json()) as ProjectOverview;
  expect(first.polling.state).toBe("live");
  expect(first.polling.lastPollAt).toEqual(expect.any(String));
  expect(first.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        issueNumber: 1,
        status: "waiting",
        reason: "ready-label-missing",
        openDependencyCount: 0,
      }),
      expect.objectContaining({
        issueNumber: 2,
        status: "blocked",
        reason: "open-native-blockers",
        openDependencyCount: 1,
        blockerRefs: ["github://Gasppacho/jarvis/issues/99"],
      }),
    ]),
  );
  const lastPollAt = first.polling.lastPollAt;

  const restore = fixture.fakeGitHub.scriptRoute(
    "GET",
    "/repos/Gasppacho/jarvis/issues?state=open&per_page=100&page=1",
    { status: 503, body: { message: "provider secret must stay private" } },
  );
  const failed = (await (
    await fixture.engine.call(`/v1/projects/${fixture.projectId}/overview/refresh`, {
      method: "POST",
    })
  ).json()) as ProjectOverview;
  restore();

  expect(failed.polling).toMatchObject({ state: "failed", lastPollAt });
  expect(failed.primaryAction).toBe("refresh");
  expect(failed.issues).toEqual(first.issues);
  expect(JSON.stringify(failed)).not.toContain("provider secret");
  expect((await overview(fixture)).issues).toEqual(first.issues);
});

it("pauses new admissions durably while keeping Resume explicit", async () => {
  const fixture = await startReferenceWorkflowFixture("overview-pause");
  fixtures.push(fixture);

  const paused = await fixture.engine.call(`/v1/projects/${fixture.projectId}/pause`, {
    method: "POST",
  });
  expect(paused.status).toBe(200);
  expect(((await paused.json()) as { status: string }).status).toBe("paused");
  expect((await overview(fixture)).status).toBe("paused");
  expect((await overview(fixture)).polling.state).toBe("paused");

  const resumed = await fixture.engine.call(`/v1/projects/${fixture.projectId}/resume`, {
    method: "POST",
  });
  expect(resumed.status).toBe(200);
  expect(((await resumed.json()) as { status: string }).status).toBe("active");
  expect(
    (
      (await (await fixture.engine.call(`/v1/projects/${fixture.projectId}`)).json()) as {
        status: string;
      }
    ).status,
  ).toBe("active");
});
