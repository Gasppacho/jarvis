import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { explain, localApiValidator } from "./contract.js";
import {
  startReferenceWorkflowFixture,
  type ReferenceWorkflowFixture,
} from "./reference-workflow-fixture.js";

const fixtures: ReferenceWorkflowFixture[] = [];
const validateDetail = localApiValidator("ExecutionDetailV1");

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

describe("execution detail", () => {
  it("projects one correlated issue through checks, push and the created PR", async () => {
    const fixture = await startReferenceWorkflowFixture("execution-detail");
    fixtures.push(fixture);
    const workItemRef = "github://Gasppacho/jarvis/issues/16";
    fixture.fakeGitHub.appendLabeledIssueEvent({
      owner: "Gasppacho",
      repository: "jarvis",
      issueNumber: 16,
      issueTitle: "Execution detail acceptance",
      issueBody: "A bounded detail body.",
      label: "ready-to-dev",
      actor: "reference-user",
      createdAt: new Date().toISOString(),
    });

    await waitForEvent(fixture, "scm.change-request.created", workItemRef);
    const targetEvents = readEventsForWorkItem(fixture, workItemRef);
    const createdEvent = targetEvents.find((event) => event.type === "scm.change-request.created");
    expect(createdEvent).toBeDefined();
    const events = targetEvents.filter(
      (event) => event.correlationId === createdEvent!.correlationId,
    );
    const eventIds = new Set(events.map((event) => event.id));
    const executions = (await readExecutions(fixture)).filter((execution) =>
      eventIds.has(execution.inputEventId),
    );
    expect(executions).toHaveLength(3);
    const implementationEvent = events.find(
      (event) => event.type === "development.implementation.requested",
    );
    expect(implementationEvent).toBeDefined();
    const implementationExecution = executions.find(
      (execution) => execution.inputEventId === implementationEvent!.id,
    );
    expect(implementationExecution).toBeDefined();
    const detailResponse = await fixture.engine.call(
      `/v1/projects/${fixture.projectId}/executions/${implementationExecution!.id}/detail`,
    );
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as Detail;
    expect(validateDetail(detail), explain(validateDetail)).toBe(true);
    expect(detail.correlationId).toMatch(/^corr_/);
    expect(detail.workItem).toMatchObject({
      ref: workItemRef,
      issueNumber: 16,
      title: "Execution detail acceptance",
    });
    expect(detail.executions).toHaveLength(3);
    expect(detail.executions.every((execution) => execution.status === "completed")).toBe(true);
    expect(detail.steps.map((step) => [step.id, step.status])).toEqual([
      ["issue-received", "proved"],
      ["eligibility-confirmed", "proved"],
      ["workspace-prepared", "proved"],
      ["agent-running", "proved"],
      ["checks", "proved"],
      ["commit-push", "proved"],
      ["pull-request", "proved"],
    ]);
    expect(detail.checks).toEqual([expect.objectContaining({ name: "test", status: "passed" })]);
    expect(detail.agentExcerpts.length).toBeLessThanOrEqual(8);
    expect(detail.workspace?.status).toBe("released");
    expect(detail.pullRequest).toMatchObject({
      ref: "github://Gasppacho/jarvis/pulls/1",
      number: 1,
      title: expect.stringContaining("Implement"),
      url: fixture.fakeGitHub.pullRequests[0]!.htmlUrl,
    });
    const overview = (await (
      await fixture.engine.call(`/v1/projects/${fixture.projectId}/overview`)
    ).json()) as {
      issues: {
        issueNumber: number;
        executionId: string | null;
        lastExecutionStatus: string | null;
      }[];
    };
    expect(overview.issues.find((issue) => issue.issueNumber === 16)).toMatchObject({
      executionId: expect.any(String),
      lastExecutionStatus: "completed",
    });
    expect(detail.technical.inputEventIds.length).toBe(3);
    expect(detail.technical.events.length).toBeGreaterThanOrEqual(5);
    const publicText = JSON.stringify(detail);
    expect(publicText).not.toContain("ghs_reference_fixture");
    expect(publicText).not.toContain("A bounded detail body.");
    expect(publicText).not.toContain("/private/tmp");
    expect(publicText).not.toContain("<path>");
    expect(publicText).not.toContain("<redacted>");
    expect(publicText).not.toMatch(/merge|auto-merge/i);
  });

  it("keeps detail project-scoped", async () => {
    const fixture = await startReferenceWorkflowFixture("execution-detail-scope");
    fixtures.push(fixture);
    const response = await fixture.engine.call(
      `/v1/projects/other-project/executions/execution-unknown/detail`,
    );
    expect(response.status).toBe(404);
  });
});

type Execution = {
  readonly id: string;
  readonly inputEventId: string;
  readonly moduleInstanceId: string;
};
type Detail = {
  readonly correlationId: string | null;
  readonly workItem: {
    readonly ref: string;
    readonly issueNumber: number | null;
    readonly title: string | null;
  } | null;
  readonly executions: readonly { readonly status: string }[];
  readonly steps: readonly { readonly id: string; readonly status: string }[];
  readonly checks: readonly { readonly name: string; readonly status: string }[];
  readonly agentExcerpts: readonly unknown[];
  readonly workspace: { readonly status: string } | null;
  readonly pullRequest: {
    readonly ref: string;
    readonly number: number | null;
    readonly title: string | null;
    readonly url: string | null;
  } | null;
  readonly technical: {
    readonly inputEventIds: readonly string[];
    readonly events: readonly unknown[];
  };
};

async function readExecutions(fixture: ReferenceWorkflowFixture): Promise<readonly Execution[]> {
  const response = await fixture.engine.call(`/v1/projects/${fixture.projectId}/executions`);
  const body = (await response.json()) as { readonly items: readonly Execution[] };
  return body.items;
}

function readEventsForWorkItem(
  fixture: ReferenceWorkflowFixture,
  workItemRef: string,
): readonly { readonly id: string; readonly type: string; readonly correlationId: string }[] {
  const database = new Database(join(fixture.engine.dataRoot, "jarvis.sqlite"), { readonly: true });
  try {
    const rows = database
      .prepare(
        `SELECT id, type, correlation_id AS correlationId
         FROM events
         WHERE project_id = ? AND json_extract(envelope, '$.payload.workItemRef') = ?
         ORDER BY occurred_at, id`,
      )
      .all(fixture.projectId, workItemRef) as {
      readonly id: string;
      readonly type: string;
      readonly correlationId: string;
    }[];
    return rows;
  } finally {
    database.close();
  }
}

async function waitForEvent(
  fixture: ReferenceWorkflowFixture,
  type: string,
  workItemRef: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (readEventsForWorkItem(fixture, workItemRef).some((event) => event.type === type)) return;
    if (Date.now() >= deadline)
      throw new Error(`execution detail timed out\n${fixture.engine.stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
