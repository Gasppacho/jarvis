import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine, type Harness } from "./harness.js";
import { ExecutionCheckpointStore } from "../src/executions/checkpoints.js";
import type { PortableProjectConfiguration } from "../../../packages/project-runtime/src/project-types.js";
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
    roots.push(fixture.root, fixture.remoteRoot);
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
    await activateProject(engine, projectId, fixture, false, 300_000, 1_048_576, {
      test: "pnpm test",
      build: "pnpm build",
    });
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
      const recordedResult = JSON.parse(recorded!.result) as {
        headBranch: string;
        headCommit: string;
      };
      expect(recordedResult).toEqual({
        status: "completed",
        summary: "Fake Runtime applied deterministic change.",
        changedFiles: ["fake-runtime-change.txt"],
        headBranch: expect.stringMatching(
          /^agent\/fixture-development-tracer-first-implementation-/,
        ),
        headCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
        validation: [{ name: "test", status: "passed", durationMs: expect.any(Number) }],
        commands: { test: "pnpm test", build: "pnpm build" },
        git: {
          branchPattern: "agent/{workItemId}-{slug}",
          commitStrategy: "conventional",
          pushRemote: "origin",
          allowForcePush: false,
        },
      });
      const outputRows = database
        .prepare(
          `SELECT envelope FROM outbox
           WHERE project_id = ?
             AND json_extract(envelope, '$.type') IN ('development.implementation.completed', 'scm.change-request.creation-requested')
           ORDER BY rowid`,
        )
        .all(projectId) as { envelope: string }[];
      expect(outputRows).toHaveLength(2);
      const [completed, creationRequested] = outputRows.map(
        ({ envelope }) => JSON.parse(envelope) as Record<string, unknown>,
      );
      expect(completed).toMatchObject({
        type: "development.implementation.completed",
        version: 1,
        kind: "fact",
        repositoryId: "main",
        subject: { type: "pushed-branch", ref: `git://main/${recordedResult.headBranch}` },
        payload: {
          workItemRef: `fixture://${projectId}/first`,
          repositoryId: "main",
          baseBranch: "main",
          headBranch: recordedResult.headBranch,
          headCommit: recordedResult.headCommit,
          validation: {
            passed: true,
            commands: [{ name: "test", status: "passed", durationMs: expect.any(Number) }],
          },
          summary: "Fake Runtime applied deterministic change.",
        },
      });
      expect(creationRequested).toMatchObject({
        type: "scm.change-request.creation-requested",
        version: 1,
        kind: "request",
        repositoryId: "main",
        subject: { type: "pushed-branch", ref: `git://main/${recordedResult.headBranch}` },
        target: { binding: "sourceControl" },
        idempotencyKey: expect.stringMatching(/^change-request:[0-9a-f]{64}$/),
        payload: {
          repositoryId: "main",
          workItemRef: `fixture://${projectId}/first`,
          baseBranch: "main",
          headBranch: recordedResult.headBranch,
          headCommit: recordedResult.headCommit,
          title: `Implement fixture-${projectId}-first`,
          description: `Implements Work Item fixture://${projectId}/first.`,
        },
      });
      expect((completed?.["payload"] as { headCommit: string }).headCommit).toBe(
        (creationRequested?.["payload"] as { headCommit: string }).headCommit,
      );
      expect(
        git(fixture.root, ["rev-list", "--count", `${before.head}..${recordedResult.headCommit}`]),
      ).toBe("1");
      const commitDetails = execFileSync(
        "git",
        ["show", "-s", "--format=%H%n%an%n%ae%n%cn%n%ce%n%B", recordedResult.headCommit],
        { cwd: fixture.root, encoding: "utf8" },
      );
      expect(commitDetails).toContain(`${recordedResult.headCommit}\nJarvis\njarvis@localhost`);
      expect(commitDetails).toContain(`Work Item: fixture://${projectId}/first`);
      expect(
        execFileSync(
          "git",
          ["--git-dir", fixture.remoteRoot, "rev-parse", `refs/heads/${recordedResult.headBranch}`],
          { encoding: "utf8" },
        ).trim(),
      ).toBe(recordedResult.headCommit);
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
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM outbox
             WHERE project_id = ?
               AND json_extract(envelope, '$.type') IN ('development.implementation.completed', 'scm.change-request.creation-requested')`,
          )
          .get(projectId),
      ).toEqual({ count: 2 });
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
    roots.push(fixture.root, fixture.remoteRoot);
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
        "validation.started",
        "commit.created",
        "branch.pushed",
      ]);
      expect(checkpoints.map((checkpoint) => checkpoint.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(checkpoints.map((checkpoint) => checkpoint.sourceSequence)).toEqual([1, 2, 3, 4, 5]);
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

  it("rejects a clean worktree without creating an empty commit", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-no-changes-"));
    roots.push(dataRoot);
    const projectId = "development-no-changes";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1", JARVIS_FAKE_SCENARIO: "clean" },
    });
    engines.push(engine);

    await activateProject(engine, projectId, fixture, true);
    await publishTag(engine, projectId, "no-changes");
    const executions = await waitForExecutions(engine, projectId, 2);
    const development = executions.find(
      (execution) => execution.moduleInstanceId === "development",
    );
    expect(development).toMatchObject({ status: "failed" });
    expect(development).toBeDefined();

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      const inbox = database
        .prepare("SELECT result FROM inbox WHERE module_instance_id = 'development'")
        .get() as { result: string };
      expect(JSON.parse(inbox.result)).toEqual({
        error: { code: "git.no-changes", message: expect.any(String), retryable: false },
      });
      expect(
        database
          .prepare(
            "SELECT type FROM execution_checkpoints WHERE execution_id = ? ORDER BY sequence",
          )
          .all(development!.id),
      ).toEqual([{ type: "agent.started" }, { type: "validation.started" }]);
      expect(
        database
          .prepare("SELECT status FROM workspace_leases WHERE project_id = ? AND execution_id = ?")
          .get(projectId, development!.id),
      ).toEqual({ status: "retained" });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM outbox
             WHERE project_id = ?
               AND json_extract(envelope, '$.type') IN ('development.implementation.completed', 'scm.change-request.creation-requested')`,
          )
          .get(projectId),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("fails when the configured push remote is unavailable", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-push-failure-"));
    roots.push(dataRoot);
    const projectId = "development-push-failure";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);
    const before = repositoryState(fixture.root);

    await activateProject(
      engine,
      projectId,
      fixture,
      false,
      300_000,
      1_048_576,
      { test: "node --test" },
      ["test"],
      false,
      "unreachable",
    );
    await publishTag(engine, projectId, "push-failure");
    const executions = await waitForExecutions(engine, projectId, 2);
    const development = executions.find(
      (execution) => execution.moduleInstanceId === "development",
    );
    expect(development).toMatchObject({ status: "failed" });
    expect(development).toBeDefined();
    expect(repositoryState(fixture.root)).toEqual(before);

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      const inbox = database
        .prepare("SELECT result FROM inbox WHERE module_instance_id = 'development'")
        .get() as { result: string };
      expect(JSON.parse(inbox.result)).toEqual({
        error: { code: "git.push-failed", message: expect.any(String), retryable: true },
      });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM outbox
             WHERE project_id = ?
               AND json_extract(envelope, '$.type') IN ('development.implementation.completed', 'scm.change-request.creation-requested')`,
          )
          .get(projectId),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            "SELECT type FROM execution_checkpoints WHERE execution_id = ? ORDER BY sequence",
          )
          .all(development!.id),
      ).toEqual([
        { type: "agent.started" },
        { type: "agent.message" },
        { type: "validation.started" },
        { type: "commit.created" },
      ]);
      expect(
        database
          .prepare("SELECT status FROM workspace_leases WHERE project_id = ? AND execution_id = ?")
          .get(projectId, development!.id),
      ).toEqual({ status: "retained" });
    } finally {
      database.close();
    }
  });

  it("cancels the real runtime child, drains it, and retains the cancelled workspace", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-cancel-"));
    roots.push(dataRoot);
    const projectId = "development-cancel";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1", JARVIS_FAKE_SCENARIO: "ignore-terminate" },
    });
    engines.push(engine);

    await activateProject(engine, projectId, fixture, true);
    await publishTag(engine, projectId, "cancelled");
    const running = await waitForExecution(engine, projectId, "development", "running");
    const workspacePath = join(dataRoot, "projects", projectId, "workspaces", running.id);
    const childPidPath = join(workspacePath, "fake-runtime-child.pid");
    const childPid = await waitForPid(childPidPath);

    const response = await engine.call(`/v1/executions/${running.id}/cancel`, { method: "POST" });
    expect(response.status).toBe(202);
    const cancelled = await waitForExecution(engine, projectId, "development", "cancelled");
    expect(cancelled.id).toBe(running.id);

    expect(existsSync(join(workspacePath, "fake-runtime-interrupt.txt"))).toBe(true);
    expect(existsSync(workspacePath)).toBe(true);
    await expectProcessGone(childPid);

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(
        database
          .prepare(
            `SELECT status FROM workspace_leases
             WHERE project_id = ? AND execution_id = ?`,
          )
          .get(projectId, running.id),
      ).toEqual({ status: "retained" });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM workspace_leases
             WHERE project_id = ? AND status = 'active'`,
          )
          .get(projectId),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM outbox
             WHERE json_extract(envelope, '$.type') IN ('development.implementation.completed', 'scm.change-request.creation-requested')`,
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("records a timed-out runtime distinctly and retains its workspace", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-timeout-"));
    roots.push(dataRoot);
    const projectId = "development-timeout";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1", JARVIS_FAKE_SCENARIO: "ignore-terminate" },
    });
    engines.push(engine);

    await activateProject(engine, projectId, fixture, true, 100);
    await publishTag(engine, projectId, "timed-out");
    const timedOut = await waitForExecution(engine, projectId, "development", "timed-out");
    const workspacePath = join(dataRoot, "projects", projectId, "workspaces", timedOut.id);

    expect(existsSync(workspacePath)).toBe(true);
    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(
        database.prepare("SELECT status FROM executions WHERE id = ?").get(timedOut.id),
      ).toEqual({
        status: "timed_out",
      });
      expect(
        database.prepare("SELECT status FROM inbox WHERE module_instance_id = 'development'").get(),
      ).toEqual({
        status: "timed_out",
      });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM workspace_leases
             WHERE project_id = ? AND status = 'active'`,
          )
          .get(projectId),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("keeps the run successful when raw output exceeds its capture limit", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-output-limit-"));
    roots.push(dataRoot);
    const projectId = "development-output-limit";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1", JARVIS_FAKE_SCENARIO: "oversized" },
    });
    engines.push(engine);

    await activateProject(engine, projectId, fixture, true, 300_000, 1_024);
    await publishTag(engine, projectId, "output-limit");
    const executions = await waitForExecutions(engine, projectId, 2);
    const development = executions.find(
      (execution) => execution.moduleInstanceId === "development",
    );
    expect(development).toMatchObject({ status: "completed" });

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(
        database
          .prepare("SELECT status FROM workspace_leases WHERE execution_id = ?")
          .get(development!.id),
      ).toEqual({ status: "released" });
      expect(
        database.prepare("SELECT result FROM inbox WHERE module_instance_id = 'development'").get(),
      ).toMatchObject({
        result: expect.stringContaining('"status":"completed"'),
      });
      const result = database
        .prepare("SELECT result FROM inbox WHERE module_instance_id = 'development'")
        .get() as {
        result: string;
      };
      expect(JSON.parse(result.result)).toMatchObject({
        status: "completed",
        validation: [{ name: "test", status: "passed", durationMs: expect.any(Number) }],
        commands: { test: "node --test" },
        git: { pushRemote: "origin" },
      });
    } finally {
      database.close();
    }
  });

  it("runs the validation plan in order and stops after the first failure", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-validation-"));
    roots.push(dataRoot);
    const projectId = "development-validation";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);

    await activateProject(
      engine,
      projectId,
      fixture,
      false,
      300_000,
      1_048_576,
      {
        test: `node -e "require('node:fs').appendFileSync('validation-order.txt', 'test\\n')"`,
        build: `node -e "require('node:fs').appendFileSync('validation-order.txt', 'build\\n'); process.exit(7)"`,
        lint: `node -e "require('node:fs').appendFileSync('validation-order.txt', 'lint\\n')"`,
      },
      ["test", "build", "lint"],
    );
    await publishTag(engine, projectId, "validation");
    const executions = await waitForExecutions(engine, projectId, 2);
    const development = executions.find(
      (execution) => execution.moduleInstanceId === "development",
    );
    expect(development).toMatchObject({ status: "failed" });
    expect(development).toBeDefined();

    const workspacePath = join(dataRoot, "projects", projectId, "workspaces", development!.id);
    expect(readFileSync(join(workspacePath, "validation-order.txt"), "utf8")).toBe("test\nbuild\n");

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      const inbox = database
        .prepare("SELECT result FROM inbox WHERE module_instance_id = 'development'")
        .get() as { result: string };
      expect(JSON.parse(inbox.result)).toEqual({
        error: { code: "git.validation-failed", message: expect.any(String), retryable: false },
      });
      expect(
        database
          .prepare(
            "SELECT type FROM execution_checkpoints WHERE execution_id = ? ORDER BY sequence",
          )
          .all(development!.id),
      ).toEqual([
        { type: "agent.started" },
        { type: "agent.message" },
        { type: "validation.started" },
        { type: "validation.started" },
        { type: "validation.failed" },
      ]);
      expect(
        database
          .prepare("SELECT status FROM workspace_leases WHERE project_id = ? AND execution_id = ?")
          .get(projectId, development!.id),
      ).toEqual({ status: "retained" });
    } finally {
      database.close();
    }
  });

  it("fails with a configuration error when a selected command is undeclared", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-missing-command-"));
    roots.push(dataRoot);
    const projectId = "development-missing-command";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);

    await activateProject(
      engine,
      projectId,
      fixture,
      false,
      300_000,
      1_048_576,
      { test: "node --test" },
      ["build"],
    );
    await publishTag(engine, projectId, "missing-command");
    const executions = await waitForExecutions(engine, projectId, 2);
    const development = executions.find(
      (execution) => execution.moduleInstanceId === "development",
    );
    expect(development).toMatchObject({ status: "failed" });
    expect(development).toBeDefined();

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      const inbox = database
        .prepare("SELECT result FROM inbox WHERE module_instance_id = 'development'")
        .get() as { result: string };
      expect(JSON.parse(inbox.result)).toEqual({
        error: { code: "project.config-invalid", message: expect.any(String), retryable: false },
      });
      expect(
        database
          .prepare(
            "SELECT type FROM execution_checkpoints WHERE execution_id = ? ORDER BY sequence",
          )
          .all(development!.id),
      ).toEqual([{ type: "agent.started" }, { type: "agent.message" }]);
      expect(
        database
          .prepare("SELECT status FROM workspace_leases WHERE project_id = ? AND execution_id = ?")
          .get(projectId, development!.id),
      ).toEqual({ status: "retained" });
    } finally {
      database.close();
    }
  });
});

async function activateProject(
  engine: Harness,
  projectId: string,
  fixture: RealGitRepositoryFixture,
  cancellationTest = false,
  timeoutMs = 300_000,
  outputLimitBytes = 1_048_576,
  commands: PortableProjectConfiguration["commands"] = { test: "node --test" },
  validationOrder: readonly string[] = ["test"],
  retainWorkspaceOnSuccess = false,
  pushRemote = "origin",
): Promise<void> {
  const portableConfig = {
    apiVersion: "jarvis.dev/project/v1",
    kind: "Project",
    metadata: { id: projectId, name: "Development tracer" },
    repositories: [{ id: "main", root: ".", defaultBranch: "main", remote: "origin" }],
    slots: { agentRuntime: { requires: "agent.execute" } },
    commands,
    git: {
      branchPattern: "agent/{workItemId}-{slug}",
      commitStrategy: "conventional",
      pushRemote,
      allowForcePush: false,
    },
    workspace: {
      strategy: "git-worktree",
      maxConcurrentExecutions: 2,
      retainOnFailureDays: 7,
    },
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
          validationOrder,
          maxRepairCycles: 0,
          retainWorkspaceOnSuccess,
          timeoutMs,
          outputLimitBytes,
          environmentAllowlist: cancellationTest ? ["JARVIS_FAKE_SCENARIO"] : [],
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
        ["completed", "failed", "cancelled", "timed-out"].includes(execution.status),
      )
    )
      return body.items;
    if (Date.now() - startedAt > 10_000)
      throw new Error("Development executions did not complete in time.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForExecution(
  engine: Harness,
  projectId: string,
  moduleInstanceId: string,
  status: string,
): Promise<{ id: string; moduleInstanceId: string; status: string }> {
  const startedAt = Date.now();
  for (;;) {
    const response = await engine.call(`/v1/projects/${projectId}/executions`);
    const body = (await response.json()) as {
      items: { id: string; moduleInstanceId: string; status: string }[];
    };
    const execution = body.items.find(
      (candidate) => candidate.moduleInstanceId === moduleInstanceId && candidate.status === status,
    );
    if (execution !== undefined) return execution;
    if (Date.now() - startedAt > 10_000) {
      throw new Error(`Development execution did not reach ${status} in time.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForPid(path: string): Promise<number> {
  const startedAt = Date.now();
  for (;;) {
    try {
      const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // The child writes the marker after the workspace is allocated.
    }
    if (Date.now() - startedAt > 10_000) throw new Error(`PID marker ${path} was not written.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function expectProcessGone(pid: number): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() - startedAt > 5_000) throw new Error(`Process ${pid} is still alive.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
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
