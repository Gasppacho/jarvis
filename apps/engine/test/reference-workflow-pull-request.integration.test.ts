import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { PortableProjectConfiguration } from "../../../packages/project-runtime/src/project-types.js";
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
  it("runs the imported guided draft after automatic command defaults and activation, stops at one PR", async () => {
    const fixture = await startReferenceWorkflowFixture("guided-pull-request", {}, true);
    fixtures.push(fixture);
    const endpoint = `/v1/projects/${fixture.projectId}`;
    const selectedWorkItemRef = "github://Gasppacho/jarvis/issues/197";
    const detail = (await (await fixture.engine.call(endpoint)).json()) as {
      status: string;
      portableConfig: PortableProjectConfiguration;
    };
    const draft = detail.portableConfig;
    expect(detail.status).toBe("draft");
    expect(draft.modules.map((module) => module.moduleId)).toEqual([
      "jarvis.module.github",
      "jarvis.module.development",
      "jarvis.module.pull-request",
    ]);
    expect(draft.repositories).toEqual([{ id: "main", root: "." }]);
    expect(draft.modules[0]?.configuration?.["repositories"]).toEqual(["main"]);
    expect(draft.modules[1]?.configuration).not.toHaveProperty("validationOrder");
    expect(Object.keys(draft.modules[1]?.configuration ?? {})).toEqual(["readyLabel"]);
    expect(JSON.stringify(draft)).not.toMatch(
      /agent:ready|merge-requested|Gasppacho|QServices|\/Users\//,
    );
    const report = (await (
      await fixture.engine.call(`${endpoint}/validation-report`, { method: "POST" })
    ).json()) as {
      valid: boolean;
      compositionFingerprint: string;
      findings: { message: string }[];
    };
    expect(report.valid, JSON.stringify(report.findings)).toBe(true);
    expect(report.findings).toEqual([]);
    const seed = (number: number, label: string, blocked = false) =>
      fixture.fakeGitHub.seedIssue({
        owner: "Gasppacho",
        repository: "jarvis",
        issue: {
          number,
          title: `Guided work ${number}`,
          body: "Implement a small tested improvement.",
          state: "open",
          labels: [{ name: label }],
          blockedBy: blocked
            ? [{ number: 999, title: "Open blocker", body: "", state: "open", labels: [] }]
            : [],
        },
      });
    seed(195, "triage");
    seed(196, "ready-to-dev", true);
    seed(197, "ready-to-dev");
    // Many accelerated polling intervals elapse while the saved draft is inactive.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(
      fixture.fakeGitHub.requests.filter((request) => request.path.includes("/issues")),
    ).toEqual([]);
    expect(readFileSync(fixture.runtimeCounterPath, "utf8")).toBe("");

    const configuration: PortableProjectConfiguration = {
      ...draft,
      modules: draft.modules.map((module) =>
        module.instanceId === "development"
          ? {
              ...module,
              configuration: { readyLabel: "ready-to-dev" },
            }
          : module,
      ),
    };
    const saved = await fixture.engine.call(`${endpoint}/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portableConfig: configuration, writeToRepository: false }),
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const reopened = (await (await fixture.engine.call(endpoint)).json()) as {
      portableConfig: PortableProjectConfiguration;
    };
    expect(reopened.portableConfig).toEqual(configuration);
    const ready = (await (
      await fixture.engine.call(`${endpoint}/validation-report`, { method: "POST" })
    ).json()) as {
      valid: boolean;
      requestRoutes: { consumer: { instanceId: string } }[];
    };
    expect(ready.valid).toBe(true);
    expect(ready.requestRoutes.map((route) => route.consumer.instanceId).sort()).toEqual([
      "development",
      "github",
    ]);
    await fixture.activate();
    const events = await waitForEventTypes(fixture, [
      "scm.work-item.observed",
      "development.implementation.completed",
      "scm.change-request.created",
    ]);
    await waitForExecutions(fixture);
    expect(fixture.fakeGitHub.pullRequests).toHaveLength(1);
    const pr = fixture.fakeGitHub.pullRequests[0]!;
    const pushed = execFileSync("git", ["rev-parse", `refs/heads/${pr.head}`], {
      cwd: fixture.bareRemoteRoot,
      encoding: "utf8",
    }).trim();
    expect(pushed).not.toBe(fixture.initialCommitSha);
    const database = new Database(`${fixture.engine.dataRoot}/jarvis.sqlite`, { readonly: true });
    try {
      const rows = database
        .prepare(
          "SELECT envelope FROM outbox WHERE project_id = ? AND json_extract(envelope, '$.type') = 'development.implementation.completed'",
        )
        .all(fixture.projectId) as { envelope: string }[];
      expect(rows).toHaveLength(1);
      const payload = JSON.parse(rows[0]!.envelope).payload;
      expect(payload).toMatchObject({
        workItemRef: selectedWorkItemRef,
        headCommit: pushed,
      });
      expect(payload).not.toHaveProperty("validation");
    } finally {
      database.close();
    }
    expect(events.filter((event) => event.type === "scm.change-request.created")).toHaveLength(1);
    await fixture.restart();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fixture.fakeGitHub.pullRequests).toHaveLength(1);
    expect(readFileSync(fixture.runtimeCounterPath, "utf8").trim().split("\n")).toHaveLength(2);
    const finalEvents = (await (await fixture.engine.call(`${endpoint}/events`)).json()) as {
      items: WorkflowEvent[];
    };
    expect(
      finalEvents.items.filter((event) => event.type === "development.implementation.requested"),
    ).toHaveLength(1);
    expect(finalEvents.items.some((event) => event.type.includes("merge"))).toBe(false);
  });

  it("creates one Pull Request from Development's completion fact", async () => {
    const fixture = await startReferenceWorkflowFixture("reference-pull-request", {
      // This test proves one explicit workflow admission. Keep the background
      // poll outside the workflow window and trigger the seed read directly;
      // repeated observations are covered by reference-workflow-fixed.
      JARVIS_GITHUB_POLL_INTERVAL_MS: "60000",
    });
    fixtures.push(fixture);
    fixture.fakeGitHub.scriptRoute("GET", "/repos/Gasppacho/jarvis", {
      status: 200,
      body: { default_branch: "release", permissions: { pull: true, push: true } },
    });
    const endpoint = `/v1/projects/${fixture.projectId}`;
    await fixture.engine.call(`${endpoint}/pause`, { method: "POST" });
    const before = (await (await fixture.engine.call(endpoint)).json()) as {
      portableConfig: PortableProjectConfiguration;
    };
    const bindingsBefore = await (await fixture.engine.call(`${endpoint}/bindings`)).json();
    const saved = await fixture.engine.call(`${endpoint}/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portableConfig: before.portableConfig, writeToRepository: false }),
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const reopened = (await (await fixture.engine.call(endpoint)).json()) as {
      portableConfig: PortableProjectConfiguration;
    };
    expect(reopened.portableConfig).toEqual(before.portableConfig);
    expect(JSON.stringify(reopened.portableConfig)).not.toContain("automation-rules");
    expect(await (await fixture.engine.call(`${endpoint}/bindings`)).json()).toEqual(
      bindingsBefore,
    );
    await fixture.activate();
    fixture.fakeGitHub.seedIssue({
      owner: "Gasppacho",
      repository: "jarvis",
      issue: {
        number: 16,
        title: "Demonstrate ready to Pull Request end-to-end",
        body: "Reference workflow acceptance body.",
        state: "open",
        labels: [{ name: "ready-to-dev" }],
        blockedBy: [],
      },
    });
    const refreshed = await fixture.engine.call(`${endpoint}/overview/refresh`, {
      method: "POST",
    });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);

    const events = await waitForEventTypes(fixture, [
      "scm.work-item.observed",
      "development.implementation.requested",
      "development.implementation.completed",
      "scm.change-request.creation-requested",
      "scm.change-request.created",
    ]);
    const executions = await waitForExecutions(fixture);
    expect(executions).toHaveLength(4);
    expect(executions.map((execution) => execution.moduleInstanceId).sort()).toEqual([
      "development",
      "development",
      "github",
      "pull-request",
    ]);
    expect(executions.every((execution) => execution.status === "completed")).toBe(true);
    expect(fixture.fakeGitHub.pullRequests).toHaveLength(1);
    expect(fixture.fakeGitHub.requests).toContainEqual(
      expect.objectContaining({
        method: "POST",
        path: "/repos/Gasppacho/jarvis/pulls",
      }),
    );
    expect(fixture.fakeGitHub.requests).toContainEqual(
      expect.objectContaining({
        method: "GET",
        path: "/repos/Gasppacho/jarvis",
      }),
    );

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
        readonly title: string;
        readonly description: string;
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
      expect(creationRequested.producer).toMatchObject({
        moduleId: "jarvis.module.pull-request",
        moduleInstanceId: "pull-request",
      });
      expect(requestPayload).toMatchObject({
        workItemRef: "github://Gasppacho/jarvis/issues/16",
        baseBranch: "release",
        headBranch: fixture.fakeGitHub.pullRequests[0]!.head,
      });
      expect(requestPayload.title).toBe("Demonstrate ready to Pull Request end-to-end");
      expect(requestPayload.description).toContain("Closes #16");
      expect(createdPayload).toMatchObject({
        changeRequestRef: "github://Gasppacho/jarvis/pulls/1",
        externalNumber: 1,
        url: fixture.fakeGitHub.pullRequests[0]!.htmlUrl,
        baseBranch: "release",
        headBranch: requestPayload.headBranch,
        headCommit: requestPayload.headCommit,
      });

      const workspaces = database
        .prepare(
          `SELECT working_branch, base_revision_sha, workspace_path, status
           FROM workspace_leases WHERE project_id = ? ORDER BY created_at`,
        )
        .all(fixture.projectId) as {
        readonly working_branch: string;
        readonly base_revision_sha: string;
        readonly workspace_path: string;
        readonly status: string;
      }[];
      expect(workspaces).toHaveLength(2);
      expect(workspaces.map((workspace) => workspace.status)).toEqual(["released", "released"]);
      expect(new Set(workspaces.map((workspace) => workspace.workspace_path)).size).toBe(2);
      expect(workspaces[1]).toMatchObject({
        working_branch: "jarvis/pr/16-demonstrate-ready-to-pull-request-end-to-end",
        base_revision_sha: requestPayload.headCommit,
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

  it.each([
    {
      id: 1,
      name: "Development fails",
      environment: { JARVIS_FAKE_SCENARIO: "failure" },
      failedModule: "development",
      failureText: "Agent Runtime reported that the implementation failed",
    },
    {
      id: 2,
      name: "the Agent Runtime returns malformed content",
      environment: { JARVIS_FAKE_PR_SUMMARY: "not-json" },
      failedModule: "pull-request",
      failureText: "must return JSON",
    },
    {
      id: 3,
      name: "the Agent Runtime modifies its review worktree",
      environment: { JARVIS_FAKE_PR_DIRTY: "1" },
      failedModule: "pull-request",
      failureText: "contains uncommitted changes",
    },
  ])("does not create a PR when $name", async ({ id, environment, failedModule, failureText }) => {
    const fixture = await startReferenceWorkflowFixture(
      `pr-failure-${id}`,
      { JARVIS_GITHUB_POLL_INTERVAL_MS: "60000" },
      false,
      true,
      true,
      environment,
    );
    fixtures.push(fixture);
    const endpoint = `/v1/projects/${fixture.projectId}`;
    fixture.fakeGitHub.seedIssue({
      owner: "Gasppacho",
      repository: "jarvis",
      issue: {
        number: 60 + id,
        title: `Failure path ${id}`,
        body: "Do not open a Pull Request after this failure.",
        state: "open",
        labels: [{ name: "ready-to-dev" }],
        blockedBy: [],
      },
    });
    const refreshed = await fixture.engine.call(`${endpoint}/overview/refresh`, { method: "POST" });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);

    const failed = await waitForExecutionStatus(fixture, failedModule, "failed");
    expect(failed.error).toContain(failureText);
    expect(fixture.fakeGitHub.pullRequests).toHaveLength(0);
    const events = (await (await fixture.engine.call(`${endpoint}/events`)).json()) as {
      items: WorkflowEvent[];
    };
    expect(
      events.items.some((event) => event.type === "scm.change-request.creation-requested"),
    ).toBe(false);
    if (failedModule === "development") {
      expect(
        events.items.some((event) => event.type === "development.implementation.completed"),
      ).toBe(false);
      expect(
        (await readExecutions(fixture)).some(
          (execution) => execution.moduleInstanceId === "pull-request",
        ),
      ).toBe(false);
    } else {
      const database = new Database(`${fixture.engine.dataRoot}/jarvis.sqlite`, { readonly: true });
      try {
        const retained = database
          .prepare(
            "SELECT count(*) AS n FROM workspace_leases WHERE project_id = ? AND status = 'retained'",
          )
          .get(fixture.projectId) as { readonly n: number };
        expect(retained.n).toBe(1);
      } finally {
        database.close();
      }
    }
  });
});

type WorkflowEvent = {
  readonly type: string;
  readonly producer?: unknown;
  readonly target?: unknown;
  readonly idempotencyKey?: string;
  readonly payload?: Record<string, unknown>;
};

type Execution = {
  readonly moduleInstanceId: string;
  readonly status: string;
  readonly error?: string | null;
};

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
      body.items.length >= 2 &&
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

async function waitForExecutionStatus(
  fixture: ReferenceWorkflowFixture,
  moduleInstanceId: string,
  status: string,
): Promise<Execution> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const execution = (await readExecutions(fixture)).find(
      (item) => item.moduleInstanceId === moduleInstanceId && item.status === status,
    );
    if (execution !== undefined) return execution;
    if (Date.now() >= deadline) {
      throw new Error(
        `reference PR execution ${moduleInstanceId}/${status} timed out\n${fixture.engine.stderr()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function readExecutions(fixture: ReferenceWorkflowFixture): Promise<readonly Execution[]> {
  const response = await fixture.engine.call(`/v1/projects/${fixture.projectId}/executions`);
  const body = (await response.json()) as { readonly items: readonly Execution[] };
  return body.items;
}

function oneEvent(events: readonly WorkflowEvent[], type: string): WorkflowEvent {
  const matches = events.filter((event) => event.type === type);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}
