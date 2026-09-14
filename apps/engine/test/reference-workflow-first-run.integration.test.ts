import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { explain, localApiValidator } from "./contract.js";
import {
  startReferenceWorkflowFixture,
  type ReferenceWorkflowFixture,
} from "./reference-workflow-fixture.js";
import type { PortableProjectConfiguration } from "../../../packages/project-runtime/src/project-types.js";

const fixtures: ReferenceWorkflowFixture[] = [];
const validatePreflight = localApiValidator("ProjectPreflightV1");
const validateOverview = localApiValidator("ProjectOverviewV1");
const validateDetail = localApiValidator("ExecutionDetailV1");

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

it("proves the first guided workflow from native blocker to one PR", async () => {
  const fixture = await startReferenceWorkflowFixture(
    "q01-first-run",
    {
      JARVIS_GITHUB_POLL_INTERVAL_MS: "1000",
    },
    true,
  );
  fixtures.push(fixture);
  const endpoint = `/v1/projects/${fixture.projectId}`;
  const issueRef = "github://Gasppacho/jarvis/issues/201";
  const blockerRef = "github://Gasppacho/jarvis/issues/999";

  const draft = await readProject(fixture);
  expect(draft.status).toBe("draft");
  expect(draft.portableConfig.repositories).toEqual([
    { id: "main", root: ".", remote: "github", defaultBranch: "main" },
  ]);
  expect(draft.portableConfig.workspace.maxConcurrentExecutions).toBe(1);
  expect(draft.portableConfig.modules.map((module) => module.instanceId)).toEqual([
    "github",
    "development",
  ]);
  expect(JSON.stringify(draft.portableConfig)).not.toMatch(
    /agent:ready|merge-requested|Gasppacho|QServices|\/Users\//,
  );
  const configuration: PortableProjectConfiguration = {
    ...draft.portableConfig,
    commands: { verify: "node --test" },
    modules: draft.portableConfig.modules.map((module) =>
      module.instanceId === "development"
        ? {
            ...module,
            configuration: {
              ...module.configuration,
              preparation: "none",
              validationOrder: ["verify"],
              maxRepairCycles: 0,
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
  expect((await readProject(fixture)).portableConfig).toEqual(configuration);
  await fixture.restart();
  const reopenedDraft = await readProject(fixture);
  expect(reopenedDraft.status).toBe("draft");
  expect(reopenedDraft.portableConfig).toEqual(configuration);
  const validationResponse = await fixture.engine.call(`${endpoint}/validation-report`, {
    method: "POST",
  });
  expect(validationResponse.status, await validationResponse.clone().text()).toBe(200);
  const validation = (await validationResponse.json()) as {
    readonly valid: boolean;
    readonly compositionFingerprint: string;
  };
  expect(validation.valid).toBe(true);

  seedIssue(fixture, "open");
  await delay(100);
  expect(issueRequests(fixture)).toBe(0);
  expect(await readExecutions(fixture)).toEqual([]);

  scriptPreflightRoutes(fixture);
  const blockedPreflight = await preflight(fixture, endpoint);
  expect(validatePreflight(blockedPreflight), explain(validatePreflight)).toBe(true);
  expect(blockedPreflight.candidateEligibility.status).toBe("available");
  expect(blockedPreflight.candidateEligibility.items).toEqual([
    expect.objectContaining({
      workItemRef: issueRef,
      status: "ineligible",
      openDependencyCount: 1,
      blockerRefs: [blockerRef],
    }),
  ]);

  const activated = await fixture.engine.call(`${endpoint}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ compositionFingerprint: validation.compositionFingerprint }),
  });
  expect(activated.status, await activated.clone().text()).toBe(200);

  const blockedOverview = await waitForIssue(fixture, (issue) => issue.status === "blocked");
  expect(validateOverview(blockedOverview), explain(validateOverview)).toBe(true);
  expect(blockedOverview.issues).toEqual([
    expect.objectContaining({
      workItemRef: issueRef,
      issueNumber: 201,
      status: "blocked",
      reason: "open-dependencies",
      openDependencyCount: 1,
      blockerRefs: [blockerRef],
      explanation: "Blocked by 1 open GitHub native dependency.",
    }),
  ]);
  const blockedExecutions = await readExecutions(fixture);
  expect(blockedExecutions).toHaveLength(1);
  expect(blockedExecutions[0]).toMatchObject({
    moduleInstanceId: "development",
    status: "completed",
  });
  expect(fixture.fakeGitHub.pullRequests).toHaveLength(0);
  expect(runtimeCalls(fixture)).toHaveLength(0);
  expect((await readEvents(fixture)).some((event) => event.type === "scm.work-item.observed")).toBe(
    true,
  );
  expect(readReadiness(fixture, issueRef)).toMatchObject({
    status: "blocked",
    blockerRefs: JSON.stringify([blockerRef]),
    admittedAt: null,
  });

  seedIssue(fixture, "closed");
  const eligiblePreflight = await preflight(fixture, endpoint);
  expect(eligiblePreflight.candidateEligibility.status).toBe("available");
  expect(eligiblePreflight.candidateEligibility.items).toEqual([
    expect.objectContaining({
      workItemRef: issueRef,
      status: "eligible",
      openDependencyCount: 0,
      blockerRefs: [],
    }),
  ]);
  await waitForReadiness(fixture, issueRef, "ready");
  const eligibleReadiness = readReadiness(fixture);
  expect(eligibleReadiness).toMatchObject({ status: "ready", blockerRefs: "[]" });

  const expectedEvents = [
    "scm.work-item.observed",
    "development.implementation.requested",
    "development.implementation.completed",
    "scm.change-request.creation-requested",
    "scm.change-request.created",
  ] as const;
  await waitForEventTypes(fixture, expectedEvents);
  const executions = await waitForCompletedExecutions(fixture);
  expect(executions).toHaveLength(5);
  expect(executions.map((execution) => execution.moduleInstanceId).sort()).toEqual([
    "development",
    "development",
    "development",
    "development",
    "github",
  ]);
  expect(
    executions.filter((execution) => execution.moduleInstanceId === "development"),
  ).toHaveLength(4);
  expect(fixture.fakeGitHub.pullRequests).toHaveLength(1);
  expect(runtimeCalls(fixture)).toHaveLength(1);

  const events = await readEvents(fixture);
  for (const type of expectedEvents) {
    const matches = events.filter((event) => event.type === type);
    if (type === "scm.work-item.observed") expect(matches.length).toBeGreaterThan(0);
    else expect(matches).toHaveLength(1);
  }
  const implementationEvent = oneEvent(events, "development.implementation.requested");
  const correlated = events.filter(
    (event) =>
      event.correlationId === implementationEvent.correlationId &&
      expectedEvents.includes(event.type as (typeof expectedEvents)[number]),
  );
  expect(new Set(correlated.map((event) => event.correlationId))).toHaveLength(1);
  expect(events.filter((event) => event.type === "scm.work-item.observed").length).toBeGreaterThan(
    1,
  );
  expect(events.some((event) => event.type.toLowerCase().includes("merge"))).toBe(false);

  const durability = readDurability(fixture);
  expect(durability.readyIdempotencyKey).toMatch(
    new RegExp(`^${fixture.projectId}:main:${issueRef}:observed:[0-9]+$`),
  );
  expect(durability.readiness).toMatchObject({
    status: "blocked",
    reason: "already-started",
    blockerRefs: "[]",
  });
  expect(durability.readiness.admittedAt).toEqual(expect.any(String));
  expect(durability.cursor.externalEventId).toEqual(expect.any(String));
  expect(durability.eventCounts).toMatchObject({
    "scm.work-item.observed": expect.any(Number),
    "development.implementation.requested": 1,
    "development.implementation.completed": 1,
    "scm.change-request.creation-requested": 1,
    "scm.change-request.created": 1,
  });
  expect(durability.eventCounts["scm.work-item.observed"]).toBeGreaterThan(0);
  expect(durability.mappings).toEqual([
    expect.objectContaining({
      status: "completed",
      resourceRef: fixture.fakeGitHub.pullRequests[0]!.htmlUrl,
    }),
  ]);

  const headBranch = fixture.fakeGitHub.pullRequests[0]!.head;
  expect(agentBranches(fixture.bareRemoteRoot)).toEqual([headBranch]);
  const headCommit = git(fixture.bareRemoteRoot, ["rev-parse", `refs/heads/${headBranch}`]);
  expect(headCommit).not.toBe(fixture.initialCommitSha);
  expect(git(fixture.bareRemoteRoot, ["ls-tree", "-r", "--name-only", headBranch])).toContain(
    "fake-runtime-change.txt",
  );

  const implementation = oneEvent(events, "development.implementation.requested");
  const development = executions.find((execution) => execution.inputEventId === implementation.id);
  expect(development).toBeDefined();
  const detailResponse = await fixture.engine.call(
    `${endpoint}/executions/${development!.id}/detail`,
  );
  expect(detailResponse.status, await detailResponse.clone().text()).toBe(200);
  const detail = (await detailResponse.json()) as ExecutionDetail;
  expect(validateDetail(detail), explain(validateDetail)).toBe(true);
  expect(detail.workItem).toMatchObject({ ref: issueRef, issueNumber: 201 });
  expect(detail.steps.map((step) => [step.id, step.status])).toEqual([
    ["issue-received", "proved"],
    ["eligibility-confirmed", "proved"],
    ["workspace-prepared", "proved"],
    ["agent-running", "proved"],
    ["checks", "proved"],
    ["commit-push", "proved"],
    ["pull-request", "proved"],
  ]);
  expect(detail.checks).toEqual([expect.objectContaining({ name: "verify", status: "passed" })]);
  expect(detail.pullRequest).toMatchObject({
    number: 1,
    url: fixture.fakeGitHub.pullRequests[0]!.htmlUrl,
  });
  expect(
    JSON.stringify({
      blockedOverview,
      blockedPreflight,
      eligiblePreflight,
      eligibleReadiness,
      detail,
    }),
  ).not.toContain("ghs_reference_fixture");

  const eventRequestCountBeforeRestart = issueEventRequests(fixture);
  await fixture.restart();
  await waitFor(
    () => issueEventRequests(fixture) > eventRequestCountBeforeRestart,
    "restart polling",
  );
  await delay(250);
  expect(fixture.fakeGitHub.pullRequests).toHaveLength(1);
  expect(runtimeCalls(fixture)).toHaveLength(1);
  expect(agentBranches(fixture.bareRemoteRoot)).toEqual([headBranch]);
  const afterRestartEvents = await readEvents(fixture);
  expect(
    afterRestartEvents.filter((event) => event.type !== "scm.work-item.observed"),
  ).toHaveLength(events.filter((event) => event.type !== "scm.work-item.observed").length);
  const afterRestartExecutions = await readExecutions(fixture);
  expect(afterRestartExecutions.every((execution) => execution.status === "completed")).toBe(true);
  expect(
    afterRestartExecutions.filter((execution) =>
      [implementation.id, oneEvent(events, "scm.change-request.creation-requested").id].includes(
        execution.inputEventId,
      ),
    ),
  ).toHaveLength(2);
  const afterRestart = readDurability(fixture);
  expect(afterRestart.eventCounts).toMatchObject({
    "development.implementation.requested":
      durability.eventCounts["development.implementation.requested"],
    "development.implementation.completed":
      durability.eventCounts["development.implementation.completed"],
    "scm.change-request.creation-requested":
      durability.eventCounts["scm.change-request.creation-requested"],
    "scm.change-request.created": durability.eventCounts["scm.change-request.created"],
  });
  expect(afterRestart.eventCounts["scm.work-item.observed"]).toBeGreaterThanOrEqual(
    durability.eventCounts["scm.work-item.observed"]!,
  );
  expect(afterRestart.mappings).toEqual(durability.mappings);
});

function seedIssue(fixture: ReferenceWorkflowFixture, blockerState: "open" | "closed"): void {
  fixture.fakeGitHub.seedIssue({
    owner: "Gasppacho",
    repository: "jarvis",
    issue: {
      number: 201,
      title: "Q01 first visible workflow",
      body: "Implement a deterministic tested improvement.",
      state: "open",
      labels: [{ name: "ready-to-dev" }],
      blockedBy: [
        { number: 999, title: "Prerequisite", body: "", state: blockerState, labels: [] },
      ],
    },
  });
}

function scriptPreflightRoutes(fixture: ReferenceWorkflowFixture): void {
  fixture.fakeGitHub.scriptRoute("GET", "/repos/Gasppacho/jarvis", {
    status: 200,
    body: { permissions: { pull: true, push: true } },
  });
  fixture.fakeGitHub.scriptRoute("GET", "/repos/Gasppacho/jarvis/labels/ready-to-dev", {
    status: 200,
    body: { name: "ready-to-dev" },
  });
}

async function readProject(fixture: ReferenceWorkflowFixture): Promise<ProjectDetail> {
  const response = await fixture.engine.call(`/v1/projects/${fixture.projectId}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ProjectDetail;
}

async function preflight(
  fixture: ReferenceWorkflowFixture,
  endpoint: string,
): Promise<ProjectPreflight> {
  const response = await fixture.engine.call(`${endpoint}/preflight`, { method: "POST" });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ProjectPreflight;
}

async function waitForIssue(
  fixture: ReferenceWorkflowFixture,
  predicate: (issue: ProjectOverviewIssue) => boolean,
): Promise<ProjectOverview> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await fixture.engine.call(`/v1/projects/${fixture.projectId}/overview`);
    expect(response.status, await response.clone().text()).toBe(200);
    const overview = (await response.json()) as ProjectOverview;
    const issue = overview.issues.find((candidate) => candidate.issueNumber === 201);
    if (issue !== undefined && predicate(issue)) return overview;
    if (Date.now() >= deadline)
      throw new Error(
        `Q01 overview did not reach the expected state ${JSON.stringify(overview.issues)}\n${fixture.engine.stderr()}`,
      );
    await delay(25);
  }
}

async function waitForEventTypes(
  fixture: ReferenceWorkflowFixture,
  expected: readonly string[],
): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const observed = await readEvents(fixture);
    if (expected.every((type) => observed.some((event) => event.type === type))) return;
    if (Date.now() >= deadline)
      throw new Error(`Q01 workflow timed out\n${fixture.engine.stderr()}`);
    await delay(25);
  }
}

async function waitForCompletedExecutions(
  fixture: ReferenceWorkflowFixture,
): Promise<readonly Execution[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const executions = await readExecutions(fixture);
    if (executions.length >= 5 && executions.every((execution) => execution.status === "completed"))
      return executions;
    if (Date.now() >= deadline)
      throw new Error(`Q01 executions timed out\n${fixture.engine.stderr()}`);
    await delay(25);
  }
}

async function readExecutions(fixture: ReferenceWorkflowFixture): Promise<readonly Execution[]> {
  const response = await fixture.engine.call(`/v1/projects/${fixture.projectId}/executions`);
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as { readonly items: readonly Execution[] };
  return body.items;
}

async function readEvents(fixture: ReferenceWorkflowFixture): Promise<readonly WorkflowEvent[]> {
  const response = await fixture.engine.call(`/v1/projects/${fixture.projectId}/events`);
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as { readonly items: readonly WorkflowEvent[] };
  return body.items;
}

async function waitForReadiness(
  fixture: ReferenceWorkflowFixture,
  workItemRef: string,
  status: "ready" | "blocked",
): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const readiness = readReadiness(fixture, workItemRef);
    if (readiness?.status === status) return;
    if (Date.now() >= deadline)
      throw new Error(`Q01 readiness did not become ${status}\n${fixture.engine.stderr()}`);
    await delay(25);
  }
}

function readReadiness(
  fixture: ReferenceWorkflowFixture,
  workItemRef = "github://Gasppacho/jarvis/issues/201",
): Readiness | undefined {
  const database = new Database(join(fixture.engine.dataRoot, "jarvis.sqlite"), { readonly: true });
  try {
    return database
      .prepare(
        `SELECT status, reason, blocker_refs AS blockerRefs, admitted_at AS admittedAt
         FROM github_work_item_readiness WHERE project_id = ? AND work_item_ref = ?`,
      )
      .get(fixture.projectId, workItemRef) as Readiness | undefined;
  } finally {
    database.close();
  }
}

function oneEvent(events: readonly WorkflowEvent[], type: string): WorkflowEvent {
  const matches = events.filter((event) => event.type === type);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function readDurability(fixture: ReferenceWorkflowFixture): DurabilitySnapshot {
  const database = new Database(join(fixture.engine.dataRoot, "jarvis.sqlite"), { readonly: true });
  try {
    const readiness = database
      .prepare(
        `SELECT status, reason, blocker_refs AS blockerRefs, admitted_at AS admittedAt
         FROM github_work_item_readiness WHERE project_id = ? AND work_item_ref = ?`,
      )
      .get(fixture.projectId, "github://Gasppacho/jarvis/issues/201") as Readiness;
    const cursor = database
      .prepare(
        `SELECT external_event_id AS externalEventId
         FROM github_cursors WHERE project_id = ? AND module_instance_id = 'github' AND repository_id = 'main'`,
      )
      .get(fixture.projectId) as Cursor;
    const readyEnvelope = database
      .prepare(
        `SELECT envelope FROM events
         WHERE project_id = ? AND type = 'scm.work-item.observed'`,
      )
      .get(fixture.projectId) as { readonly envelope: string };
    const readyIdempotencyKey = (JSON.parse(readyEnvelope.envelope) as { idempotencyKey: string })
      .idempotencyKey;
    const eventCounts = Object.fromEntries(
      database
        .prepare(
          `SELECT type, COUNT(*) AS count FROM events
           WHERE project_id = ? AND type IN (
             'scm.work-item.observed', 'development.implementation.requested',
             'development.implementation.completed', 'scm.change-request.creation-requested',
             'scm.change-request.created'
           ) GROUP BY type`,
        )
        .all(fixture.projectId)
        .map((row) => {
          const value = row as { readonly type: string; readonly count: number };
          return [value.type, value.count] as const;
        }),
    );
    const mappings = database
      .prepare(
        `SELECT idempotency_key AS idempotencyKey, status, resource_ref AS resourceRef
         FROM external_mappings WHERE project_id = ? AND module_instance_id = 'github'`,
      )
      .all(fixture.projectId) as readonly Mapping[];
    return { readiness, cursor, readyIdempotencyKey, eventCounts, mappings };
  } finally {
    database.close();
  }
}

function issueRequests(fixture: ReferenceWorkflowFixture): number {
  return fixture.fakeGitHub.requests.filter((request) => request.path.includes("/issues")).length;
}

function issueEventRequests(fixture: ReferenceWorkflowFixture): number {
  return fixture.fakeGitHub.requests.filter((request) =>
    request.path.startsWith("/repos/Gasppacho/jarvis/issues/events"),
  ).length;
}

function runtimeCalls(fixture: ReferenceWorkflowFixture): readonly string[] {
  const text = readFileSync(fixture.runtimeCounterPath, "utf8").trim();
  return text === "" ? [] : text.split("\n");
}

function agentBranches(remoteRoot: string): readonly string[] {
  return git(remoteRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
    .split("\n")
    .filter((branch) => branch.startsWith("agent/"));
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["--git-dir", cwd, ...args], { encoding: "utf8" }).trim();
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Q01 ${description} timed out`);
    await delay(25);
  }
}

type ProjectDetail = {
  readonly status: string;
  readonly portableConfig: PortableProjectConfiguration;
};
type ProjectPreflight = {
  readonly candidateEligibility: {
    readonly status: string;
    readonly items: readonly {
      readonly workItemRef: string;
      readonly status: string;
      readonly openDependencyCount: number;
      readonly blockerRefs: readonly string[];
    }[];
  };
};
type ProjectOverview = {
  readonly issues: readonly ProjectOverviewIssue[];
};
type ProjectOverviewIssue = {
  readonly workItemRef: string;
  readonly issueNumber: number;
  readonly status: string;
  readonly reason: string;
  readonly explanation: string;
  readonly openDependencyCount: number;
  readonly blockerRefs: readonly string[];
};
type Execution = {
  readonly id: string;
  readonly inputEventId: string;
  readonly moduleInstanceId: string;
  readonly status: string;
};
type WorkflowEvent = {
  readonly id: string;
  readonly type: string;
  readonly correlationId: string | null;
};
type ExecutionDetail = {
  readonly workItem: { readonly ref: string; readonly issueNumber: number | null } | null;
  readonly steps: readonly { readonly id: string; readonly status: string }[];
  readonly checks: readonly { readonly name: string; readonly status: string }[];
  readonly pullRequest: { readonly number: number | null; readonly url: string | null } | null;
};
type Readiness = {
  readonly status: string;
  readonly reason: string;
  readonly blockerRefs: string;
  readonly admittedAt: string | null;
};
type Cursor = { readonly externalEventId: string };
type Mapping = {
  readonly idempotencyKey: string;
  readonly status: string;
  readonly resourceRef: string | null;
};
type DurabilitySnapshot = {
  readonly readiness: Readiness;
  readonly cursor: Cursor;
  readonly readyIdempotencyKey: string;
  readonly eventCounts: Readonly<Record<string, number>>;
  readonly mappings: readonly Mapping[];
};
