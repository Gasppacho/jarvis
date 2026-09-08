import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine, type Harness } from "./harness.js";
import { ExecutionCheckpointStore } from "../src/executions/checkpoints.js";
import {
  makeRealGitRepositoryFixture,
  type RealGitRepositoryFixture,
} from "./repository-fixture.js";

const testBundlePath = fileURLToPath(
  new URL("../../../dist/engine/engine.test-bundle.mjs", import.meta.url),
);
const engines: Harness[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Development Module tracer bullet", () => {
  it("runs the bound Fake Runtime in a real allocated worktree", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-"));
    roots.push(dataRoot);
    const projectId = "development-tracer";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);

    const before = repositoryState(fixture.root);
    await activateProject(engine, projectId, fixture);
    const firstFact = await publishTag(engine, projectId);
    const firstExecutions = await waitForExecutions(engine, projectId, 2);

    expect(
      firstExecutions.filter((execution) => execution.moduleInstanceId === "development"),
    ).toHaveLength(1);
    expect(
      firstExecutions.every((execution) => execution.status === "completed"),
      JSON.stringify(firstExecutions),
    ).toBe(true);
    expect(repositoryState(fixture.root)).toEqual(before);

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      const requestEvent = database
        .prepare(
          `SELECT id FROM events
           WHERE project_id = ? AND type = 'development.implementation.requested'`,
        )
        .get(projectId) as { id: string } | undefined;
      expect(requestEvent).toBeDefined();
      const recorded = database
        .prepare(
          `SELECT result FROM inbox
           WHERE project_id = ? AND module_instance_id = 'development'`,
        )
        .get(projectId) as { result: string } | undefined;
      expect(recorded).toBeDefined();
      expect(JSON.parse(recorded!.result)).toEqual({
        status: "completed",
        summary: "Fake Runtime applied deterministic change.",
        changedFiles: ["fake-runtime-change.txt"],
      });
      expect(
        database
          .prepare(
            `SELECT status FROM workspace_leases
             WHERE project_id = ? AND execution_id = ?`,
          )
          .get(
            projectId,
            firstExecutions.find((execution) => execution.moduleInstanceId === "development")!.id,
          ),
      ).toEqual({ status: "released" });

      const redelivery = await engine.call("/test/redeliver", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          moduleInstanceId: "development",
          moduleId: "jarvis.module.development",
          eventId: requestEvent!.id,
        }),
      });
      const redeliveryBody = (await redelivery.json()) as {
        redelivered: boolean;
        executionId: string | null;
      };
      expect(redeliveryBody).toMatchObject({ redelivered: true, executionId: null });
      expect(database.prepare("SELECT COUNT(*) AS count FROM executions").get()).toEqual({
        count: 2,
      });
    } finally {
      database.close();
    }

    const secondFact = await publishTag(engine, projectId, "first", 2);
    const allExecutions = await waitForExecutions(engine, projectId, 4);
    const developmentRuns = allExecutions.filter(
      (execution) => execution.moduleInstanceId === "development",
    );
    expect(developmentRuns).toHaveLength(2);
    expect(repositoryState(fixture.root)).toEqual(before);
    expect(secondFact).not.toBe(firstFact);
  });

  it("durably records ordered agent checkpoints across a dropped stream and restart", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-agent-checkpoints-"));
    roots.push(dataRoot);
    const projectId = "development-checkpoints";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);

    await activateProject(engine, projectId, fixture);
    const liveStream = engine.openStream();
    liveStream.close();
    await publishTag(engine, projectId, "checkpointed");
    const executions = await waitForExecutions(engine, projectId, 2);
    const developmentExecution = executions.find(
      (execution) => execution.moduleInstanceId === "development",
    );
    expect(developmentExecution).toBeDefined();

    const trackedEngine = engines.indexOf(engine);
    if (trackedEngine >= 0) engines.splice(trackedEngine, 1);
    await engine.dispose();

    const restarted = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(restarted);

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      const checkpoints = new ExecutionCheckpointStore(database).list(
        projectId,
        developmentExecution!.id,
      );
      expect(checkpoints.map((checkpoint) => checkpoint.type)).toEqual([
        "agent.started",
        "agent.message",
      ]);
      expect(checkpoints.map((checkpoint) => checkpoint.sequence)).toEqual([1, 2]);
      expect(checkpoints.map((checkpoint) => checkpoint.sourceSequence)).toEqual([1, 2]);
      expect(checkpoints[1]?.payload).toEqual({
        message: "Fake Runtime applied deterministic change.",
      });
      expect(JSON.stringify(checkpoints)).not.toContain(fixture.root);
      expect(JSON.stringify(checkpoints)).not.toMatch(/\/(?:Users|home|private\/var)\//);

      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM outbox
             WHERE json_extract(envelope, '$.type') IN ('agent.started', 'agent.message')`,
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});

async function activateProject(
  engine: Harness,
  projectId: string,
  fixture: RealGitRepositoryFixture,
): Promise<void> {
  const portableConfig = {
    apiVersion: "jarvis.dev/project/v1",
    kind: "Project",
    metadata: { id: projectId, name: "Development tracer" },
    repositories: [{ id: "main", root: ".", defaultBranch: "main", remote: "origin" }],
    slots: { agentRuntime: { requires: "agent.execute" } },
    commands: {},
    git: {
      branchPattern: "agent/{workItemId}-{slug}",
      commitStrategy: "conventional",
      pushRemote: "origin",
      allowForcePush: false,
    },
    workspace: { strategy: "git-worktree", maxConcurrentExecutions: 2, retainOnFailureDays: 7 },
    modules: [
      {
        instanceId: "automation-rules",
        moduleId: "jarvis.module.automation-rules",
        enabled: true,
        configuration: {
          rules: [
            {
              id: "ready-label-starts-development",
              when: {
                eventType: "scm.work-item.tag-added",
                equals: { "payload.tag": "agent:ready" },
              },
              emit: {
                type: "development.implementation.requested",
                target: { moduleInstanceId: "development" },
              },
            },
          ],
        },
      },
      {
        instanceId: "development",
        moduleId: "jarvis.module.development",
        enabled: true,
        runtimeSlot: "agentRuntime",
        bindings: { repository: "main" },
        configuration: {
          validationOrder: ["test"],
          maxRepairCycles: 0,
          retainWorkspaceOnSuccess: false,
          timeoutMs: 300_000,
          outputLimitBytes: 1_048_576,
          environmentAllowlist: [],
        },
      },
      {
        instanceId: "request-worker",
        moduleId: "jarvis.module.test-request-worker",
        enabled: true,
      },
    ],
  };
  const imported = await engine.call("/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryPath: fixture.root, portableConfig }),
  });
  expect(imported.status, await imported.clone().text()).toBe(201);
  const repositoryBinding = await engine.call(
    `/v1/projects/${projectId}/repositories/main/binding`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: realpathSync(fixture.root),
        bookmarkRef: "bookmark/development-tracer",
      }),
    },
  );
  expect(repositoryBinding.status, await repositoryBinding.clone().text()).toBe(200);
  const bindings = await engine.call(`/v1/projects/${projectId}/bindings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      apiVersion: "jarvis.dev/project-bindings/v1",
      kind: "ProjectBindings",
      projectId,
      repositories: {
        main: { path: realpathSync(fixture.root), bookmarkRef: "bookmark/development-tracer" },
      },
      slots: { agentRuntime: { kind: "runtime", ref: "runtime/fake-test" } },
    }),
  });
  expect(bindings.status, await bindings.clone().text()).toBe(200);
  const reportResponse = await engine.call(`/v1/projects/${projectId}/validation-report`, {
    method: "POST",
  });
  const report = (await reportResponse.json()) as {
    valid: boolean;
    compositionFingerprint?: string;
  };
  expect(reportResponse.status).toBe(200);
  expect(report.valid, JSON.stringify(report)).toBe(true);
  const activated = await engine.call(`/v1/projects/${projectId}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ compositionFingerprint: report.compositionFingerprint }),
  });
  expect(activated.status, await activated.clone().text()).toBe(200);
}

async function publishTag(
  engine: Harness,
  projectId: string,
  suffix = "first",
  generation = 1,
): Promise<string> {
  const response = await engine.call("/test/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "scm.work-item.tag-added",
      version: 1,
      kind: "fact",
      projectId,
      repositoryId: "main",
      producer: { moduleId: "jarvis.module.github", moduleInstanceId: "github" },
      subject: { type: "work-item", ref: `fixture://${projectId}/${suffix}` },
      correlationId: `corr_${suffix}`,
      causationId: null,
      payload: {
        workItemRef: `fixture://${projectId}/${suffix}`,
        tag: "agent:ready",
      },
      ...(generation === 1 ? {} : { metadata: { generation } }),
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const envelope = (await response.json()) as { id: string };
  return envelope.id;
}

async function waitForExecutions(
  engine: Harness,
  projectId: string,
  count: number,
): Promise<readonly { id: string; moduleInstanceId: string; status: string }[]> {
  const startedAt = Date.now();
  for (;;) {
    const response = await engine.call(`/v1/projects/${projectId}/executions`);
    const body = (await response.json()) as {
      items: { id: string; moduleInstanceId: string; status: string }[];
    };
    if (
      body.items.length >= count &&
      body.items.every((execution) =>
        ["completed", "failed", "cancelled"].includes(execution.status),
      )
    )
      return body.items;
    if (Date.now() - startedAt > 10_000)
      throw new Error("Development executions did not complete in time.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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

function git(repositoryPath: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: repositoryPath, encoding: "utf8" }).trim();
}
