import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PortableProjectConfiguration } from "../../../packages/project-runtime/src/project-types.js";
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

it("keeps the failed work linked after label removal and Engine restart", async () => {
  const fixture = await startReferenceWorkflowFixture("overview-validation-failure");
  fixtures.push(fixture);
  const path = `/v1/projects/${fixture.projectId}`;
  const detail = (await (await fixture.engine.call(path)).json()) as {
    portableConfig: PortableProjectConfiguration;
  };
  const save = await fixture.engine.call(`${path}/configuration`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      portableConfig: {
        ...detail.portableConfig,
        commands: { ...detail.portableConfig.commands, test: 'node -e "process.exit(7)"' },
      },
      writeToRepository: false,
    }),
  });
  expect(save.status).toBe(200);
  await fixture.activate();
  fixture.fakeGitHub.appendLabeledIssueEvent({
    owner: "Gasppacho",
    repository: "jarvis",
    issueNumber: 16,
    issueTitle: "Keep this validation failure visible",
    issueBody: "A bounded fixture",
    label: "agent:ready",
    actor: "reference-user",
    createdAt: new Date().toISOString(),
  });
  await expect
    .poll(
      async () => {
        const result = (await (await fixture.engine.call(`${path}/executions`)).json()) as {
          items: { status: string }[];
        };
        return result.items.some((execution) => execution.status === "failed");
      },
      { timeout: 15000 },
    )
    .toBe(true);
  seedIssue(fixture, 16);
  await fixture.engine.call(`${path}/overview/refresh`, { method: "POST" });
  const failed = await overview(fixture);
  const issue = failed.issues.find((item) => item.issueNumber === 16);
  expect(issue).toMatchObject({
    executionId: expect.any(String),
    lastExecutionStatus: "failed",
    reason: "execution-failed",
  });
  expect(failed.status).toBe("degraded");
  await expect
    .poll(async () => {
      const failureDetail = (await (
        await fixture.engine.call(`${path}/executions/${issue!.executionId}/detail`)
      ).json()) as { failure: { code: string } };
      return failureDetail.failure.code;
    })
    .toBe("git.validation-failed");
  const failureDetail = (await (
    await fixture.engine.call(`${path}/executions/${issue!.executionId}/detail`)
  ).json()) as { failure: { message: string; nextAction: string } };
  expect(failureDetail.failure.message).toMatch(/La commande .+ a échoué/);
  expect(failureDetail.failure.nextAction).toContain("corriger la cause avant de relancer");
  await fixture.restart();
  expect((await overview(fixture)).issues.find((item) => item.issueNumber === 16)).toMatchObject({
    executionId: issue!.executionId,
    lastExecutionStatus: "failed",
  });
  expect(fixture.fakeGitHub.pullRequests).toHaveLength(0);
  const capture = process.env["JARVIS_OVERVIEW_CAPTURE_DIR"];
  if (capture !== undefined) {
    const pause = await fixture.engine.call(`${path}/pause`, { method: "POST" });
    expect(pause.status).toBe(200);
    mkdirSync(capture, { recursive: true });
    writeFileSync(
      join(capture, "failed-overview.json"),
      JSON.stringify(await overview(fixture), null, 2),
    );
    await fixture.engine.dispose();
    cpSync(fixture.engine.dataRoot, join(capture, "data"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
});
