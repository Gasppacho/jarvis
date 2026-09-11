import { execFileSync } from "node:child_process";
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

describe("reference workflow redelivery", () => {
  it("keeps one PR and one branch when every chained step is replayed", async () => {
    const fixture = await startReferenceWorkflowFixture("reference-redelivery");
    fixtures.push(fixture);
    fixture.fakeGitHub.appendLabeledIssueEvent({
      owner: "Gasppacho",
      repository: "jarvis",
      issueNumber: 16,
      issueTitle: "Reference workflow",
      issueBody: "Reference body",
      label: "agent:ready",
      actor: "reference-user",
      createdAt: new Date().toISOString(),
    });
    await waitForEventTypes(fixture, [
      "scm.work-item.tag-added",
      "development.implementation.requested",
      "development.implementation.completed",
      "scm.change-request.creation-requested",
      "scm.change-request.created",
    ]);

    const database = new Database(`${fixture.engine.dataRoot}/jarvis.sqlite`, { readonly: true });
    try {
      const rows = database
        .prepare("SELECT id, envelope FROM events WHERE project_id = ? ORDER BY rowid")
        .all(fixture.projectId) as { readonly id: string; readonly envelope: string }[];
      const events = rows.map(({ id, envelope }) => ({
        id,
        ...(JSON.parse(envelope) as WorkflowEvent),
      }));
      const tag = oneEvent(events, "scm.work-item.tag-added");
      const implementation = oneEvent(events, "development.implementation.requested");
      const creation = oneEvent(events, "scm.change-request.creation-requested");
      const executionsBefore = await executions(fixture);
      expect(executionsBefore).toHaveLength(3);
      const branchBefore = agentBranches(fixture.bareRemoteRoot);
      expect(branchBefore).toHaveLength(1);
      const branchHeadBefore = git(fixture.bareRemoteRoot, [
        "rev-parse",
        `refs/heads/${branchBefore[0]}`,
      ]);
      const branchCommitCountBefore = Number(
        git(fixture.bareRemoteRoot, ["rev-list", "--count", `refs/heads/${branchBefore[0]}`]),
      );
      const pullRequestRequestsBefore = pullRequestRequests(fixture);

      await redeliver(fixture, creation.id, "github", "jarvis.module.github");
      await redeliver(fixture, implementation.id, "development", "jarvis.module.development");
      await redeliver(fixture, tag.id, "automation-rules", "jarvis.module.automation-rules");
      const eventRequestsBeforePoll = issueEventRequests(fixture);
      await waitFor(() => issueEventRequests(fixture) > eventRequestsBeforePoll);

      const executionsAfter = await executions(fixture);
      expect(executionsAfter).toEqual(executionsBefore);
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM events
             WHERE project_id = ? AND type = 'scm.work-item.tag-added'`,
          )
          .get(fixture.projectId),
      ).toEqual({ count: 1 });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM events
             WHERE project_id = ? AND type = 'scm.change-request.created'`,
          )
          .get(fixture.projectId),
      ).toEqual({ count: 1 });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM events
             WHERE project_id = ? AND type = 'scm.change-request.creation-requested'`,
          )
          .get(fixture.projectId),
      ).toEqual({ count: 1 });
      const mappings = database
        .prepare(
          `SELECT idempotency_key, status, resource_ref
           FROM external_mappings
           WHERE project_id = ? AND module_instance_id = 'github'`,
        )
        .all(fixture.projectId) as readonly Mapping[];
      expect(
        mappings.filter((mapping) => mapping.idempotency_key === creation.idempotencyKey),
      ).toEqual([
        {
          idempotency_key: creation.idempotencyKey,
          status: "completed",
          resource_ref: fixture.fakeGitHub.pullRequests[0]!.htmlUrl,
        },
      ]);
      expect(tag.id).not.toBe(implementation.id);
      expect(fixture.fakeGitHub.pullRequests).toHaveLength(1);
      expect(pullRequestRequests(fixture)).toBe(pullRequestRequestsBefore);
      expect(agentBranches(fixture.bareRemoteRoot)).toEqual(branchBefore);
      expect(git(fixture.bareRemoteRoot, ["rev-parse", `refs/heads/${branchBefore[0]}`])).toBe(
        branchHeadBefore,
      );
      expect(
        Number(
          git(fixture.bareRemoteRoot, ["rev-list", "--count", `refs/heads/${branchBefore[0]}`]),
        ),
      ).toBe(branchCommitCountBefore);
    } finally {
      database.close();
    }
  });
});

type WorkflowEvent = {
  readonly type: string;
  readonly idempotencyKey?: string;
};

async function redeliver(
  fixture: ReferenceWorkflowFixture,
  eventId: string,
  moduleInstanceId: string,
  moduleId: string,
): Promise<void> {
  const response = await fixture.engine.call("/test/redeliver", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: fixture.projectId,
      moduleInstanceId,
      moduleId,
      eventId,
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({
    redelivered: true,
    executionId: null,
    status: "completed",
  });
}

async function waitForEventTypes(
  fixture: ReferenceWorkflowFixture,
  expected: readonly string[],
): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await fixture.engine.call(`/v1/projects/${fixture.projectId}/events`);
    const body = (await response.json()) as {
      readonly items: readonly { readonly type: string }[];
    };
    const observed = new Set(body.items.map((event) => event.type));
    if (expected.every((type) => observed.has(type))) return;
    if (Date.now() >= deadline)
      throw new Error(`redelivery events timed out\n${fixture.engine.stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function executions(fixture: ReferenceWorkflowFixture): Promise<readonly Execution[]> {
  const response = await fixture.engine.call(`/v1/projects/${fixture.projectId}/executions`);
  const body = (await response.json()) as { readonly items: readonly Execution[] };
  return body.items;
}

function oneEvent(events: readonly (WorkflowEvent & { readonly id: string })[], type: string) {
  const matches = events.filter((event) => event.type === type);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function issueEventRequests(fixture: ReferenceWorkflowFixture): number {
  return fixture.fakeGitHub.requests.filter((request) =>
    request.path.startsWith("/repos/Gasppacho/jarvis/issues/events"),
  ).length;
}

function pullRequestRequests(fixture: ReferenceWorkflowFixture): number {
  return fixture.fakeGitHub.requests.filter(
    (request) => request.method === "POST" && request.path === "/repos/Gasppacho/jarvis/pulls",
  ).length;
}

function agentBranches(remoteRoot: string): readonly string[] {
  return git(remoteRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
    .split("\n")
    .filter((branch) => branch.startsWith("agent/"));
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["--git-dir", cwd, ...args], { encoding: "utf8" }).trim();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("polling did not revisit the label window");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type Execution = {
  readonly id: string;
  readonly moduleInstanceId: string;
  readonly status: string;
};
type Mapping = {
  readonly idempotency_key: string;
  readonly status: string;
  readonly resource_ref: string;
};
