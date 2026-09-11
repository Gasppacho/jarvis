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

describe("reference workflow pull request", () => {
  it("creates one Pull Request from Development's sourceControl request", async () => {
    const fixture = await startReferenceWorkflowFixture("reference-pull-request");
    fixtures.push(fixture);
    fixture.fakeGitHub.appendLabeledIssueEvent({
      owner: "Gasppacho",
      repository: "jarvis",
      issueNumber: 16,
      issueTitle: "Demonstrate agent:ready to Pull Request end-to-end",
      issueBody: "Reference workflow acceptance body.",
      label: "agent:ready",
      actor: "reference-user",
      createdAt: new Date().toISOString(),
    });

    const events = await waitForEventTypes(fixture, [
      "scm.work-item.tag-added",
      "development.implementation.requested",
      "development.implementation.completed",
      "scm.change-request.creation-requested",
      "scm.change-request.created",
    ]);
    const executions = await waitForExecutions(fixture);
    expect(executions).toHaveLength(3);
    expect(executions.map((execution) => execution.moduleInstanceId).sort()).toEqual([
      "automation-rules",
      "development",
      "github",
    ]);
    expect(executions.every((execution) => execution.status === "completed")).toBe(true);
    expect(fixture.fakeGitHub.pullRequests).toHaveLength(1);

    const database = new Database(`${fixture.engine.dataRoot}/jarvis.sqlite`, { readonly: true });
    try {
      const envelopes = database
        .prepare(
          `SELECT envelope FROM outbox
           WHERE project_id = ?
             AND json_extract(envelope, '$.type') IN (
               'scm.change-request.creation-requested',
               'scm.change-request.created'
             )
           ORDER BY rowid`,
        )
        .all(fixture.projectId) as { readonly envelope: string }[];
      const requests = envelopes.map(({ envelope }) => JSON.parse(envelope) as WorkflowEvent);
      const creationRequested = oneEvent(requests, "scm.change-request.creation-requested");
      const created = oneEvent(requests, "scm.change-request.created");
      const requestPayload = creationRequested.payload as {
        readonly workItemRef: string;
        readonly baseBranch: string;
        readonly headBranch: string;
        readonly headCommit: string;
      };
      const createdPayload = created.payload as {
        readonly changeRequestRef: string;
        readonly externalNumber: number;
        readonly url: string;
        readonly baseBranch: string;
        readonly headBranch: string;
        readonly headCommit: string;
      };
      expect(creationRequested.target).toEqual({ binding: "sourceControl" });
      expect(requestPayload).toMatchObject({
        workItemRef: "github://Gasppacho/jarvis/issues/16",
        baseBranch: "main",
        headBranch: fixture.fakeGitHub.pullRequests[0]!.head,
      });
      expect(createdPayload).toMatchObject({
        changeRequestRef: "github://Gasppacho/jarvis/pulls/1",
        externalNumber: 1,
        url: fixture.fakeGitHub.pullRequests[0]!.htmlUrl,
        baseBranch: "main",
        headBranch: requestPayload.headBranch,
        headCommit: requestPayload.headCommit,
      });

      const mappings = database
        .prepare(
          `SELECT idempotency_key, status, resource_ref
           FROM external_mappings
           WHERE project_id = ? AND module_instance_id = 'github'`,
        )
        .all(fixture.projectId) as {
        readonly idempotency_key: string;
        readonly status: string;
        readonly resource_ref: string;
      }[];
      expect(mappings).toEqual(
        expect.arrayContaining([
          {
            idempotency_key: creationRequested.idempotencyKey,
            status: "completed",
            resource_ref: fixture.fakeGitHub.pullRequests[0]!.htmlUrl,
          },
        ]),
      );
    } finally {
      database.close();
    }
    expect(events.filter((event) => event.type === "scm.change-request.created")).toHaveLength(1);
  });
});

type WorkflowEvent = {
  readonly type: string;
  readonly target?: unknown;
  readonly idempotencyKey?: string;
  readonly payload?: Record<string, unknown>;
};

type Execution = { readonly moduleInstanceId: string; readonly status: string };

async function waitForEventTypes(
  fixture: ReferenceWorkflowFixture,
  expectedTypes: readonly string[],
): Promise<readonly { readonly type: string }[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await fixture.engine.call(`/v1/projects/${fixture.projectId}/events`);
    const body = (await response.json()) as {
      readonly items: readonly { readonly type: string }[];
    };
    const observed = new Set(body.items.map((event) => event.type));
    if (expectedTypes.every((type) => observed.has(type))) return body.items;
    if (Date.now() >= deadline)
      throw new Error(`reference PR events timed out\n${fixture.engine.stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForExecutions(fixture: ReferenceWorkflowFixture): Promise<readonly Execution[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await fixture.engine.call(`/v1/projects/${fixture.projectId}/executions`);
    const body = (await response.json()) as { readonly items: readonly Execution[] };
    if (
      body.items.length >= 3 &&
      body.items.some((execution) => execution.moduleInstanceId === "github") &&
      body.items.every((execution) => execution.status === "completed")
    )
      return body.items;
    if (Date.now() >= deadline) {
      throw new Error(`reference PR executions timed out: ${JSON.stringify(body.items)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function oneEvent(events: readonly WorkflowEvent[], type: string): WorkflowEvent {
  const matches = events.filter((event) => event.type === type);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}
