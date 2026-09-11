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

describe("reference workflow Work Item naming", () => {
  it("uses the Issue number and title while keeping each execution distinct", async () => {
    const fixture = await startReferenceWorkflowFixture("reference-naming");
    fixtures.push(fixture);
    fixture.fakeGitHub.appendLabeledIssueEvent({
      owner: "Gasppacho",
      repository: "jarvis",
      issueNumber: 21,
      issueTitle: "Add a health endpoint",
      issueBody: "Implement the endpoint.",
      label: "agent:ready",
      actor: "reference-user",
      createdAt: new Date().toISOString(),
    });

    await waitForEvent(fixture, "scm.change-request.creation-requested");
    const database = new Database(`${fixture.engine.dataRoot}/jarvis.sqlite`, { readonly: true });
    try {
      const row = database
        .prepare(
          `SELECT envelope FROM outbox
           WHERE project_id = ?
             AND json_extract(envelope, '$.type') = 'scm.change-request.creation-requested'`,
        )
        .get(fixture.projectId) as { readonly envelope: string };
      const event = JSON.parse(row.envelope) as {
        readonly payload: {
          readonly headBranch: string;
          readonly title: string;
          readonly description: string;
        };
      };
      expect(event.payload).toMatchObject({
        headBranch: expect.stringMatching(/^agent\/21-add-a-health-endpoint-exec-[a-f0-9-]+$/),
        title: "Implement Add a health endpoint",
        description: "Implements Work Item github://Gasppacho/jarvis/issues/21.",
      });
      expect(
        git(fixture.bareRemoteRoot, ["show", "-s", "--format=%s", event.payload.headBranch]),
      ).toBe("feat: implement add-a-health-endpoint");
    } finally {
      database.close();
    }
  });
});

async function waitForEvent(fixture: ReferenceWorkflowFixture, type: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await fixture.engine.call(`/v1/projects/${fixture.projectId}/events`);
    const body = (await response.json()) as {
      readonly items: readonly { readonly type: string }[];
    };
    if (body.items.some((event) => event.type === type)) return;
    if (Date.now() >= deadline)
      throw new Error(`event ${type} timed out\n${fixture.engine.stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["--git-dir", cwd, ...args], { encoding: "utf8" }).trim();
}
