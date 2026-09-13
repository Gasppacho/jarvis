import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  startReferenceWorkflowFixture,
  type ReferenceWorkflowFixture,
} from "./reference-workflow-fixture.js";

const fixtures: ReferenceWorkflowFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

describe("fixed GitHub to Development workflow", () => {
  it("turns repeated observations into one targeted implementation and one PR", async () => {
    const fixture = await startReferenceWorkflowFixture(
      "fixed-observation-development",
      {},
      false,
      true,
    );
    fixtures.push(fixture);
    fixture.fakeGitHub.seedIssue({
      owner: "Gasppacho",
      repository: "jarvis",
      issue: {
        number: 222,
        title: "Fixed workflow issue",
        body: "Implement the requested change.",
        state: "open",
        labels: [{ name: "ready-to-dev" }],
        blockedBy: [],
      },
    });
    for (let poll = 0; poll < 10; poll += 1) {
      const refreshed = await fixture.engine.call(
        `/v1/projects/${fixture.projectId}/overview/refresh`,
        { method: "POST" },
      );
      expect(refreshed.status, await refreshed.clone().text()).toBe(200);
    }

    const events = await waitForEvents(fixture, [
      "scm.work-item.observed",
      "development.implementation.requested",
      "development.implementation.completed",
      "scm.change-request.creation-requested",
      "scm.change-request.created",
    ]);
    const observed = events.filter((event) => event.type === "scm.work-item.observed");
    expect(observed.length).toBeGreaterThanOrEqual(10);
    expect(new Set(observed.map((event) => event.id)).size).toBe(observed.length);
    expect(
      events.filter((event) => event.type === "development.implementation.requested"),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === "scm.change-request.created")).toHaveLength(1);
    expect(fixture.fakeGitHub.pullRequests).toHaveLength(1);

    const database = new Database(`${fixture.engine.dataRoot}/jarvis.sqlite`, { readonly: true });
    try {
      const requestRow = database
        .prepare(
          "SELECT envelope FROM events WHERE project_id = ? AND type = 'development.implementation.requested'",
        )
        .get(fixture.projectId) as { readonly envelope: string };
      const request = JSON.parse(requestRow.envelope) as WorkflowEvent;
      const sourceObservation = observed.find((event) => event.id === request.causationId);
      expect(request.target).toEqual({ moduleInstanceId: "development" });
      expect(sourceObservation).toBeDefined();
      expect(request.correlationId).toBe(sourceObservation!.correlationId);
      expect(request.payload).toMatchObject({
        repositoryId: "main",
        workItemRef: "github://Gasppacho/jarvis/issues/222",
        baseBranch: "main",
        tag: "ready-to-dev",
        requestedGeneration: expect.any(Number),
      });
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM github_work_item_readiness WHERE project_id = ? AND repository_id = ? AND work_item_ref = ? AND admitted_at IS NOT NULL",
          )
          .get(fixture.projectId, "main", "github://Gasppacho/jarvis/issues/222"),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });
});

type WorkflowEvent = {
  readonly id: string;
  readonly type: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly target?: unknown;
  readonly payload?: Record<string, unknown>;
};

async function waitForEvents(
  fixture: ReferenceWorkflowFixture,
  expectedTypes: readonly string[],
): Promise<readonly WorkflowEvent[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await fixture.engine.call(`/v1/projects/${fixture.projectId}/events`);
    const body = (await response.json()) as { readonly items: readonly WorkflowEvent[] };
    if (expectedTypes.every((type) => body.items.some((event) => event.type === type))) {
      return body.items;
    }
    if (Date.now() >= deadline) {
      throw new Error(`fixed workflow timed out\n${fixture.engine.stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
