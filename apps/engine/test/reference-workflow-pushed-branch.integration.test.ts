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

describe("reference workflow pushed branch", () => {
  it("turns one agent:ready label into one validated pushed branch", async () => {
    const fixture = await startReferenceWorkflowFixture("reference-pushed-branch");
    fixtures.push(fixture);
    const before = repositoryState(fixture.repositoryRoot);

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

    await waitForEvents(fixture);
    const executions = await waitForCompletedExecutions(fixture);
    const database = new Database(`${fixture.engine.dataRoot}/jarvis.sqlite`, { readonly: true });
    try {
      const storedEvents = database
        .prepare(
          `SELECT envelope FROM outbox
           WHERE project_id = ?
             AND json_extract(envelope, '$.type') IN (
               'scm.work-item.tag-added',
               'development.implementation.requested',
               'development.implementation.completed',
               'scm.change-request.creation-requested'
             )
           ORDER BY rowid`,
        )
        .all(fixture.projectId) as { readonly envelope: string }[];
      const persistedEvents = storedEvents.map(({ envelope }) => JSON.parse(envelope) as ProjectEvent);
      const completed = oneEvent(persistedEvents, "development.implementation.completed");
      const creationRequested = oneEvent(persistedEvents, "scm.change-request.creation-requested");
      const completedPayload = completed.payload as {
        readonly headBranch: string;
        readonly headCommit: string;
      };
      const creationPayload = creationRequested.payload as {
        readonly headBranch: string;
        readonly headCommit: string;
      };
      expect(creationPayload.headBranch).toBe(completedPayload.headBranch);
      expect(creationPayload.headCommit).toBe(completedPayload.headCommit);
      expect(repositoryState(fixture.repositoryRoot)).toEqual(before);
      expect(executions.filter((execution) => execution.moduleInstanceId === "development")).toHaveLength(1);
      expect(executions.every((execution) => execution.status === "completed")).toBe(true);
      const branches = gitDir(fixture.bareRemoteRoot, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
      ])
        .split("\n")
        .filter((branch) => branch.startsWith("agent/"));
      expect(branches).toEqual([completedPayload.headBranch]);
      expect(gitDir(fixture.bareRemoteRoot, ["rev-parse", `refs/heads/${completedPayload.headBranch}`])).toBe(
        completedPayload.headCommit,
      );
      expect(
        gitDir(fixture.bareRemoteRoot, ["rev-parse", `${completedPayload.headCommit}^`]),
      ).toBe(fixture.initialCommitSha);
      expect(
        gitDir(fixture.bareRemoteRoot, ["ls-tree", "-r", "--name-only", completedPayload.headCommit]),
      ).toContain("fake-runtime-change.txt");
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM workspace_leases WHERE project_id = ? AND status = 'active'",
          )
          .get(fixture.projectId),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});

type ProjectEvent = {
  readonly type: string;
  readonly payload?: Record<string, unknown>;
};

type ProjectExecution = {
  readonly moduleInstanceId: string;
  readonly status: string;
};

async function waitForEvents(fixture: ReferenceWorkflowFixture): Promise<readonly ProjectEvent[]> {
  const expected = new Set([
    "scm.work-item.tag-added",
    "development.implementation.requested",
    "development.implementation.completed",
    "scm.change-request.creation-requested",
  ]);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await fixture.engine.call(`/v1/projects/${fixture.projectId}/events`);
    const body = (await response.json()) as { readonly items: readonly ProjectEvent[] };
    const observed = new Set(body.items.map((event) => event.type));
    if ([...expected].every((type) => observed.has(type))) return body.items;
    if (Date.now() >= deadline) throw new Error(`reference workflow events timed out\n${fixture.engine.stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForCompletedExecutions(
  fixture: ReferenceWorkflowFixture,
): Promise<readonly ProjectExecution[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await fixture.engine.call(`/v1/projects/${fixture.projectId}/executions`);
    const body = (await response.json()) as { readonly items: readonly ProjectExecution[] };
    if (
      body.items.some((execution) => execution.moduleInstanceId === "development") &&
      body.items.every((execution) => execution.status === "completed")
    )
      return body.items;
    if (Date.now() >= deadline) throw new Error(`reference workflow executions timed out\n${fixture.engine.stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function oneEvent(events: readonly ProjectEvent[], type: string): ProjectEvent {
  const matches = events.filter((event) => event.type === type);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function repositoryState(repositoryPath: string): {
  readonly head: string;
  readonly branch: string;
  readonly status: string;
} {
  return {
    head: git(repositoryPath, ["rev-parse", "HEAD"]),
    branch: git(repositoryPath, ["branch", "--show-current"]),
    status: git(repositoryPath, ["status", "--porcelain"]),
  };
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitDir(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["--git-dir", cwd, ...args], { encoding: "utf8" }).trim();
}
