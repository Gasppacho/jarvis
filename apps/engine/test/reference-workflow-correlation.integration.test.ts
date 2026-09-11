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

describe("reference workflow correlation", () => {
  it("links two labels into separate, public-safe event and execution chains", async () => {
    const fixture = await startReferenceWorkflowFixture("reference-correlation");
    fixtures.push(fixture);
    appendIssue(fixture, 16, "First reference issue", "First reference body.");
    appendIssue(fixture, 17, "Second reference issue", "Second reference body.");
    await waitForCreatedFacts(fixture);

    const database = new Database(`${fixture.engine.dataRoot}/jarvis.sqlite`, { readonly: true });
    try {
      const events = readJournal(database, fixture.projectId);
      const first = chainFor(events, 16);
      const second = chainFor(events, 17);
      expect(first).toHaveLength(5);
      expect(second).toHaveLength(5);
      expectChain(first);
      expectChain(second);

      const firstIds = new Set(first.map((event) => event.id));
      const secondIds = new Set(second.map((event) => event.id));
      expect([...firstIds].some((id) => secondIds.has(id))).toBe(false);
      expect(first[0]!.correlationId).not.toBe(second[0]!.correlationId);

      const firstTimeline = await listEvents(fixture, first[0]!.correlationId);
      const secondTimeline = await listEvents(fixture, second[0]!.correlationId);
      expect(firstTimeline.map((event) => event.id).sort()).toEqual([...firstIds].sort());
      expect(secondTimeline.map((event) => event.id).sort()).toEqual([...secondIds].sort());
      expect(await listEvents(fixture, "corr_unknown_reference_workflow")).toEqual([]);

      const executions = await listExecutions(fixture);
      expectExecutions(executions, first, firstIds);
      expectExecutions(executions, second, secondIds);

      const publicResponses = await Promise.all([
        fixture.engine.call(`/v1/projects/${fixture.projectId}/events`),
        fixture.engine.call(`/v1/projects/${fixture.projectId}/executions`),
      ]);
      const publicText = await Promise.all(publicResponses.map((response) => response.text()));
      const publicJson = publicText.join("\n");
      expect(publicJson).not.toContain("ghs_reference_fixture");
      expect(publicJson).not.toContain("First reference body");
      expect(publicJson).not.toContain("Second reference body");
      expect(publicJson).not.toContain('"payload"');
      expect(publicJson).not.toContain('"credential"');
    } finally {
      database.close();
    }
  });
});

function appendIssue(
  fixture: ReferenceWorkflowFixture,
  issueNumber: number,
  issueTitle: string,
  issueBody: string,
): void {
  fixture.fakeGitHub.appendLabeledIssueEvent({
    owner: "Gasppacho",
    repository: "jarvis",
    issueNumber,
    issueTitle,
    issueBody,
    label: "agent:ready",
    actor: "reference-user",
    createdAt: new Date().toISOString(),
  });
}

function readJournal(database: Database.Database, projectId: string): readonly WorkflowEvent[] {
  return (
    database
      .prepare("SELECT id, envelope FROM events WHERE project_id = ? ORDER BY rowid")
      .all(projectId) as readonly { readonly id: string; readonly envelope: string }[]
  ).map(({ id, envelope }) => ({ id, ...(JSON.parse(envelope) as Omit<WorkflowEvent, "id">) }));
}

function chainFor(events: readonly WorkflowEvent[], issueNumber: number): readonly WorkflowEvent[] {
  const ref = `github://Gasppacho/jarvis/issues/${issueNumber}`;
  const tag = events.find(
    (event) => event.type === "scm.work-item.tag-added" && event.payload?.workItemRef === ref,
  );
  expect(tag).toBeDefined();
  return events.filter((event) => event.correlationId === tag!.correlationId);
}

function expectChain(events: readonly WorkflowEvent[]): void {
  const byType = (type: string): WorkflowEvent => {
    const matches = events.filter((event) => event.type === type);
    expect(matches).toHaveLength(1);
    return matches[0]!;
  };
  const tag = byType("scm.work-item.tag-added");
  const implementation = byType("development.implementation.requested");
  const completed = byType("development.implementation.completed");
  const creation = byType("scm.change-request.creation-requested");
  const created = byType("scm.change-request.created");
  expect(tag.causationId).toBeNull();
  expect(implementation.causationId).toBe(tag.id);
  expect(completed.causationId).toBe(implementation.id);
  expect(creation.causationId).toBe(implementation.id);
  expect(created.causationId).toBe(creation.id);
  expect(new Set(events.map((event) => event.correlationId))).toHaveLength(1);
}

async function listEvents(
  fixture: ReferenceWorkflowFixture,
  correlationId: string,
): Promise<readonly { readonly id: string }[]> {
  const response = await fixture.engine.call(
    `/v1/projects/${fixture.projectId}/events?correlationId=${encodeURIComponent(correlationId)}`,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { readonly items: readonly { readonly id: string }[] };
  return body.items;
}

async function listExecutions(fixture: ReferenceWorkflowFixture): Promise<readonly Execution[]> {
  const response = await fixture.engine.call(`/v1/projects/${fixture.projectId}/executions`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { readonly items: readonly Execution[] };
  return body.items;
}

function expectExecutions(
  executions: readonly Execution[],
  events: readonly WorkflowEvent[],
  eventIds: ReadonlySet<string>,
): void {
  const related = executions.filter((execution) => eventIds.has(execution.inputEventId));
  expect(related).toHaveLength(3);
  expect(related.every((execution) => execution.correlationId === events[0]!.correlationId)).toBe(
    true,
  );
  expect(new Set(related.map((execution) => execution.inputEventId))).toEqual(
    new Set(
      events
        .filter((event) =>
          [
            "scm.work-item.tag-added",
            "development.implementation.requested",
            "scm.change-request.creation-requested",
          ].includes(event.type),
        )
        .map((event) => event.id),
    ),
  );
}

async function waitForCreatedFacts(fixture: ReferenceWorkflowFixture): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await fixture.engine.call(`/v1/projects/${fixture.projectId}/events`);
    const body = (await response.json()) as {
      readonly items: readonly { readonly type: string }[];
    };
    const created = body.items.filter((event) => event.type === "scm.change-request.created");
    if (created.length === 2) return;
    if (Date.now() >= deadline) {
      throw new Error(`reference correlation timed out\n${fixture.engine.stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type WorkflowEvent = {
  readonly id: string;
  readonly type: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly payload?: { readonly workItemRef?: string };
};

type Execution = {
  readonly inputEventId: string;
  readonly correlationId?: string;
};
