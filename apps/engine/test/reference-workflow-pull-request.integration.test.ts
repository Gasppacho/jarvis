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
  it("runs the imported guided draft only after explicit command choices and activation, stops at one PR", async () => {
    const fixture = await startReferenceWorkflowFixture("guided-pull-request", {}, true);
    fixtures.push(fixture);
    const endpoint = `/v1/projects/${fixture.projectId}`;
    const detail = (await (await fixture.engine.call(endpoint)).json()) as {
      status: string;
      portableConfig: PortableProjectConfiguration;
    };
    const draft = detail.portableConfig;
    expect(detail.status).toBe("draft");
    expect(draft.modules.map((module) => module.moduleId)).toEqual([
      "jarvis.module.github",
      "jarvis.module.automation-rules",
      "jarvis.module.development",
    ]);
    expect(draft.workspace.maxConcurrentExecutions).toBe(1);
    expect(draft.repositories).toEqual([
      { id: "main", root: ".", remote: "github", defaultBranch: "main" },
    ]);
    expect(draft.git.pushRemote).toBe("origin");
    expect(draft.modules[0]?.configuration?.["repositories"]).toEqual(["main"]);
    expect(draft.modules[2]?.configuration?.["validationOrder"]).toEqual([]);
    expect(draft.modules[2]?.configuration?.["preparation"]).toBeUndefined();
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
    expect(report.valid).toBe(false);
    expect(report.findings.map((f) => f.message).join(" ")).toContain("confirm at least one");
    expect(report.findings.map((f) => f.message).join(" ")).toContain("preparation");
    const refused = await fixture.engine.call(`${endpoint}/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ compositionFingerprint: report.compositionFingerprint }),
    });
    expect(refused.status).toBe(409);

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
    seed(195, "ready-for-agent");
    seed(196, "ready-for-agent", true);
    seed(197, "agent:ready");
    // Many accelerated polling intervals elapse while the saved draft is inactive.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(
      fixture.fakeGitHub.requests.filter((request) => request.path.includes("/issues")),
    ).toEqual([]);
    expect(readFileSync(fixture.runtimeCounterPath, "utf8")).toBe("");

    const configuration: PortableProjectConfiguration = {
      ...draft,
      commands: { verify: "node --test" },
      modules: draft.modules.map((module) =>
        module.instanceId === "development"
          ? {
              ...module,
              configuration: {
                ...module.configuration,
                preparation: "none",
                validationOrder: ["verify"],
                environmentAllowlist: ["JARVIS_FAKE_COUNTER_PATH"],
              },
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
      "development",
      "github",
    ]);
    await fixture.activate();
    const events = await waitForEventTypes(fixture, [
      "scm.work-item.ready",
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
      expect(JSON.parse(rows[0]!.envelope).payload).toMatchObject({
        workItemRef: "github://Gasppacho/jarvis/issues/195",
        headCommit: pushed,
        validation: { passed: true, commands: [{ name: "verify", status: "passed" }] },
      });
    } finally {
      database.close();
    }
    expect(events.filter((event) => event.type === "scm.change-request.created")).toHaveLength(1);
    await fixture.restart();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fixture.fakeGitHub.pullRequests).toHaveLength(1);
    expect(readFileSync(fixture.runtimeCounterPath, "utf8").trim().split("\n")).toHaveLength(1);
    const finalEvents = (await (await fixture.engine.call(`${endpoint}/events`)).json()) as {
      items: WorkflowEvent[];
    };
    expect(
      finalEvents.items.filter((event) => event.type === "development.implementation.requested"),
    ).toHaveLength(1);
    expect(finalEvents.items.some((event) => event.type.includes("merge"))).toBe(false);
  });

  it("creates one Pull Request from Development's sourceControl request", async () => {
    const fixture = await startReferenceWorkflowFixture("reference-pull-request");
    fixtures.push(fixture);
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
    expect(JSON.stringify(reopened.portableConfig.modules[1])).toContain("agent:ready");
    expect(await (await fixture.engine.call(`${endpoint}/bindings`)).json()).toEqual(
      bindingsBefore,
    );
    await fixture.activate();
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
    expect(fixture.fakeGitHub.requests).toContainEqual(
      expect.objectContaining({
        method: "POST",
        path: "/repos/Gasppacho/jarvis/pulls",
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
