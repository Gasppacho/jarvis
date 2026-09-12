import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startEngine, startFakeGitHubApi, type FakeGitHubApi, type Harness } from "./harness.js";
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
const servers: FakeGitHubApi[] = [];
const githubEnvironments: Array<{
  readonly executable: string | undefined;
  readonly apiBaseUrl: string | undefined;
}> = [];

beforeEach(async () => {
  githubEnvironments.push({
    executable: process.env["JARVIS_GH_EXECUTABLE"],
    apiBaseUrl: process.env["JARVIS_GITHUB_API_BASE_URL"],
  });
  const root = mkdtempSync(join("/tmp", "jarvis-development-gh-"));
  roots.push(root);
  const executable = join(root, "gh");
  writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' 'ghs_development_fixture'\n", "utf8");
  chmodSync(executable, 0o755);
  const server = await startFakeGitHubApi();
  servers.push(server);
  process.env["JARVIS_GH_EXECUTABLE"] = executable;
  process.env["JARVIS_GITHUB_API_BASE_URL"] = server.baseUrl;
});

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  const environment = githubEnvironments.pop()!;
  if (environment.executable === undefined) delete process.env["JARVIS_GH_EXECUTABLE"];
  else process.env["JARVIS_GH_EXECUTABLE"] = environment.executable;
  if (environment.apiBaseUrl === undefined) delete process.env["JARVIS_GITHUB_API_BASE_URL"];
  else process.env["JARVIS_GITHUB_API_BASE_URL"] = environment.apiBaseUrl;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Development Module tracer bullet", () => {
  it("keeps a closed GitHub Issue pending without a workspace, retry, or dead letter", async () => {
    const fixture = makeRealGitRepositoryFixture({
      remoteUrl: "git@github.com:Gasppacho/jarvis.git",
    });
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-pending-closed-"));
    roots.push(dataRoot);
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);
    const missing = await engine.call("/v1/projects/missing/development-admission");
    expect(missing.status).toBe(404);
    expect((await missing.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "project.not-found" },
    });
    const github = servers[0]!;
    const workItemRef = "github://Gasppacho/jarvis/issues/44";
    github.seedIssue({
      owner: "Gasppacho",
      repository: "jarvis",
      issue: {
        number: 44,
        title: "Closed while waiting",
        body: "External body must not be persisted.",
        state: "closed",
        labels: [{ name: "agent:ready" }],
      },
    });

    await activateProject(engine, "development-pending-closed", fixture);
    await publishTag(engine, "development-pending-closed", "closed-pending", 1, workItemRef);
    await waitForAdmission(dataRoot, "development-pending-closed", "ineligible");
    const admission = await engine.call(
      "/v1/projects/development-pending-closed/development-admission",
    );
    expect(admission.status, await admission.clone().text()).toBe(200);
    expect(await admission.json()).toMatchObject({
      suspended: false,
      items: [
        {
          workItemRef,
          status: "ineligible",
          reason: "work-item-closed",
        },
      ],
    });
    const suspended = await engine.call(
      "/v1/projects/development-pending-closed/development-admission/suspend",
      { method: "POST" },
    );
    expect(await suspended.json()).toMatchObject({ suspended: true });
    const resumed = await engine.call(
      "/v1/projects/development-pending-closed/development-admission/resume",
      { method: "POST" },
    );
    expect(await resumed.json()).toMatchObject({ suspended: false });

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM dead_letters WHERE module_instance_id = 'development'",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM workspace_leases").get()).toEqual({
        count: 0,
      });
      expect(
        database
          .prepare(
            "SELECT attempt_count FROM deliveries WHERE project_id = ? AND module_instance_id = 'development'",
          )
          .get("development-pending-closed"),
      ).toEqual({ attempt_count: 0 });
    } finally {
      database.close();
    }
  });

  it("does not start a new Development workspace while admission is suspended, then resumes it", async () => {
    const fixture = makeRealGitRepositoryFixture({
      remoteUrl: "git@github.com:Gasppacho/jarvis.git",
    });
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-suspended-"));
    roots.push(dataRoot);
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);
    const github = servers[0]!;
    const workItemRef = "github://Gasppacho/jarvis/issues/45";
    github.seedIssue({
      owner: "Gasppacho",
      repository: "jarvis",
      issue: {
        number: 45,
        title: "Suspended before start",
        body: "External body must not be persisted.",
        state: "open",
        labels: [{ name: "agent:ready" }],
      },
    });
    await activateProject(engine, "development-suspended", fixture);
    const suspended = await engine.call(
      "/v1/projects/development-suspended/development-admission/suspend",
      { method: "POST" },
    );
    expect(suspended.status).toBe(200);
    await publishTag(engine, "development-suspended", "suspended", 1, workItemRef);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM workspace_leases WHERE project_id = 'development-suspended'",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM executions WHERE project_id = 'development-suspended' AND module_instance_id = 'development'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }

    const resumed = await engine.call(
      "/v1/projects/development-suspended/development-admission/resume",
      { method: "POST" },
    );
    expect(resumed.status).toBe(200);
    const executions = await waitForExecutions(engine, "development-suspended", 2);
    expect(executions.some(({ moduleInstanceId }) => moduleInstanceId === "development")).toBe(
      true,
    );
  });

  it("reads the bound open GitHub Issue before allocating and running Development", async () => {
    const fixture = makeRealGitRepositoryFixture({
      remoteUrl: "git@github.com:Gasppacho/jarvis.git",
    });
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-work-item-"));
    roots.push(dataRoot);
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);
    const github = servers[0]!;
    const workItemRef = "github://Gasppacho/jarvis/issues/42";
    github.seedIssue({
      owner: "Gasppacho",
      repository: "jarvis",
      issue: {
        number: 42,
        title: "Read verified issue",
        body: "External untrusted body",
        state: "open",
        labels: [{ name: "agent:ready" }],
      },
    });

    await activateProject(engine, "development-work-item", fixture);
    await publishTag(engine, "development-work-item", "work-item", 1, workItemRef);
    const executions = await waitForExecutions(engine, "development-work-item", 2);
    const development = executions.find(
      ({ moduleInstanceId }) => moduleInstanceId === "development",
    );
    expect(development, JSON.stringify(executions)).toMatchObject({
      status: "failed",
      error: "The configured remote does not point to the committed working branch.",
    });
    expect(github.requests).toContainEqual({
      method: "GET",
      path: "/repos/Gasppacho/jarvis/issues/42",
      credential: "ghs_development_fixture",
    });
    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(
        database
          .prepare(
            "SELECT type FROM execution_checkpoints WHERE execution_id = ? ORDER BY sequence",
          )
          .all(development!.id),
      ).toEqual(expect.arrayContaining([{ type: "agent.started" }]));
      expect(
        database
          .prepare("SELECT message FROM dead_letters WHERE module_instance_id = 'development'")
          .get(),
      ).not.toMatchObject({ message: expect.stringContaining("External untrusted body") });
    } finally {
      database.close();
    }
  });

  it("runs a project-bound Codex Runtime through a fake executable", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-codex-"));
    roots.push(dataRoot);
    const executable = join(dataRoot, "fake-codex");
    writeFileSync(
      executable,
      `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.153.4\\n");
  process.exit(0);
}
if (process.argv.includes("login") && process.argv.includes("status")) {
  process.stderr.write("Logged in using ChatGPT\\n");
  process.exit(0);
}
fs.appendFileSync("run-order.txt", "agent\\n");
fs.writeFileSync("codex-runtime-change.txt", "Codex runtime change\\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ type: "item.completed", item: { type: "file_change", id: "change-1", changes: [{ path: "codex-runtime-change.txt" }] } });
emit({ type: "item.completed", item: { type: "agent_message", text: "Codex Runtime applied deterministic change." } });
emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
`,
      "utf8",
    );
    chmodSync(executable, 0o755);

    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);

    const database = new Database(join(dataRoot, "jarvis.sqlite"));
    database
      .prepare(
        `INSERT INTO runtime_descriptors
           (id, provider, display_name, executable_path, version, capabilities, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           display_name = excluded.display_name,
           executable_path = excluded.executable_path,
           version = excluded.version,
           capabilities = excluded.capabilities,
           status = excluded.status`,
      )
      .run(
        "runtime/codex-default",
        "codex",
        "Codex — default",
        executable,
        "0.153.4",
        JSON.stringify(["agent.execute"]),
        "available",
      );
    database.close();

    const before = repositoryState(fixture.root);
    const projectId = "development-codex";
    const commands = {
      install: `node -e "require('node:fs').writeFileSync('run-order.txt','install\\n')"`,
      test: `node -e "const fs=require('node:fs'); if (fs.readFileSync('run-order.txt','utf8') !== 'install\\nagent\\n') process.exit(7); fs.appendFileSync('run-order.txt','validation\\n')"`,
    };
    await activateProject(
      engine,
      projectId,
      fixture,
      false,
      300_000,
      1_048_576,
      commands,
      ["test"],
      false,
      "origin",
      0,
      "runtime/codex-default",
    );
    await publishTag(engine, projectId, "codex");
    const executions = await waitForExecutions(engine, projectId, 2);
    expect(
      executions.find(({ moduleInstanceId }) => moduleInstanceId === "development"),
      JSON.stringify(executions),
    ).toMatchObject({
      status: "completed",
    });
    expect(repositoryState(fixture.root)).toEqual(before);

    const readonly = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      const row = readonly
        .prepare(
          "SELECT result FROM inbox WHERE project_id = ? AND module_instance_id = 'development'",
        )
        .get(projectId) as { result: string } | undefined;
      expect(row).toBeDefined();
      const result = JSON.parse(row!.result) as {
        status: string;
        summary: string;
        changedFiles: string[];
        headBranch: string;
        headCommit: string;
      };
      expect(result).toMatchObject({
        status: "completed",
        summary: "Codex Runtime applied deterministic change.",
        changedFiles: ["codex-runtime-change.txt"],
      });
      expect(
        execFileSync(
          "git",
          ["--git-dir", fixture.remoteRoot, "show", `${result.headCommit}:run-order.txt`],
          { encoding: "utf8" },
        ),
      ).toBe("install\nagent\nvalidation\n");
      expect(
        execFileSync(
          "git",
          ["--git-dir", fixture.remoteRoot, "rev-parse", `refs/heads/${result.headBranch}`],
          { encoding: "utf8" },
        ).trim(),
      ).toBe(result.headCommit);
    } finally {
      readonly.close();
    }
  });

  it("does not spawn Codex when its bound executable disappears before preflight", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-codex-preflight-"));
    roots.push(dataRoot);
    const executable = join(dataRoot, "gone-codex");
    const spawnMarker = join(dataRoot, "codex-spawned");
    writeFileSync(
      executable,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(spawnMarker)}, 'spawned')\n`,
      "utf8",
    );
    chmodSync(executable, 0o755);

    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1" },
    });
    engines.push(engine);
    const database = new Database(join(dataRoot, "jarvis.sqlite"));
    database
      .prepare(
        `INSERT INTO runtime_descriptors
           (id, provider, display_name, executable_path, version, capabilities, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET executable_path = excluded.executable_path, status = excluded.status`,
      )
      .run(
        "runtime/codex-default",
        "codex",
        "Codex — default",
        executable,
        "0.153.4",
        JSON.stringify(["agent.execute"]),
        "available",
      );
    database.close();

    const projectId = "development-codex-preflight";
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
      "origin",
      0,
      "runtime/codex-default",
    );
    chmodSync(executable, 0o644);
    await publishTag(engine, projectId, "preflight");
    const executions = await waitForExecutions(engine, projectId, 2);
    const development = executions.find(
      ({ moduleInstanceId }) => moduleInstanceId === "development",
    );
    expect(development).toMatchObject({ status: "failed" });
    expect(existsSync(spawnMarker)).toBe(false);

    const readonly = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(readFailureEvent(readonly, projectId)).toMatchObject({
        payload: { code: "agent.runtime-preflight-failed", retryable: true },
      });
      expect(
        readonly
          .prepare("SELECT COUNT(*) AS count FROM execution_checkpoints WHERE execution_id = ?")
          .get(development!.id),
      ).toEqual({ count: 0 });
    } finally {
      readonly.close();
    }
  });

  it("retains a failed preparation without starting, validating, committing, pushing, or requesting a PR", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-preparation-failure-"));
    roots.push(dataRoot);
    const projectId = "development-preparation-failure";
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
        install: "node -e \"process.stderr.write('install failed'); process.exit(7)\"",
        test: "false",
      },
      ["test"],
    );
    await publishTag(engine, projectId, "preparation-failure");
    const executions = await waitForExecutions(engine, projectId, 2);
    const development = executions.find(
      ({ moduleInstanceId }) => moduleInstanceId === "development",
    );
    expect(development).toMatchObject({ status: "failed" });

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(readFailureEvent(database, projectId)).toMatchObject({
        payload: { code: "project.preparation-failed", retryable: true },
      });
      expect(
        database
          .prepare(
            "SELECT type FROM execution_checkpoints WHERE execution_id = ? ORDER BY sequence",
          )
          .all(development!.id),
      ).toEqual([{ type: "preparation.started" }, { type: "preparation.failed" }]);
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
          .prepare("SELECT status FROM workspace_leases WHERE execution_id = ?")
          .get(development!.id),
      ).toEqual({ status: "retained" });
    } finally {
      database.close();
    }
  });

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
    const commands = {
      test: `node -e "const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); if (!process.cwd().includes('/workspaces/') || !fs.existsSync('fake-runtime-change.txt') || !fs.existsSync('src/server.ts') || execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim() !== '${before.head}') process.exit(7)"`,
      build: `node -e "require('node:fs').accessSync('src/server.ts')"`,
    };
    await activateProject(engine, projectId, fixture, false, 300_000, 1_048_576, commands, [
      "test",
      "build",
    ]);
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
        validation: [
          { name: "test", status: "passed", durationMs: expect.any(Number) },
          { name: "build", status: "passed", durationMs: expect.any(Number) },
        ],
        commands,
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
            commands: [
              { name: "test", status: "passed", durationMs: expect.any(Number) },
              { name: "build", status: "passed", durationMs: expect.any(Number) },
            ],
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
      expect(
        execFileSync(
          "git",
          ["--git-dir", fixture.remoteRoot, "rev-parse", `${recordedResult.headCommit}^`],
          { encoding: "utf8" },
        ).trim(),
      ).toBe(before.head);
      const committedFiles = execFileSync(
        "git",
        [
          "--git-dir",
          fixture.remoteRoot,
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          recordedResult.headCommit,
        ],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter((file) => file !== "");
      expect(committedFiles.length).toBeGreaterThan(0);
      expect(committedFiles).toContain("fake-runtime-change.txt");
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
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM workspace_leases WHERE project_id = ? AND status = 'active'",
          )
          .get(projectId),
      ).toEqual({ count: 0 });

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
      const replayedCreationRequest = database
        .prepare(
          `SELECT envelope FROM outbox
           WHERE project_id = ?
             AND json_extract(envelope, '$.type') = 'scm.change-request.creation-requested'`,
        )
        .get(projectId) as { envelope: string };
      expect(
        (JSON.parse(replayedCreationRequest.envelope) as { idempotencyKey: string }).idempotencyKey,
      ).toBe(creationRequested?.["idempotencyKey"]);
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

    await activateProject(engine, projectId, fixture, "clean");
    await publishTag(engine, projectId, "no-changes");
    const executions = await waitForExecutions(engine, projectId, 2);
    const development = executions.find(
      (execution) => execution.moduleInstanceId === "development",
    );
    expect(development).toMatchObject({ status: "failed" });
    expect(development).toBeDefined();

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(
        database
          .prepare(
            "SELECT code, message, attempts FROM dead_letters WHERE module_instance_id = 'development'",
          )
          .get(),
      ).toEqual({ code: "git.no-changes", message: expect.any(String), attempts: 1 });
      expect(
        database.prepare("SELECT 1 FROM inbox WHERE module_instance_id = 'development'").get(),
      ).toBeUndefined();
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
      expect(readFailureEvent(database, projectId)).toMatchObject({
        type: "development.implementation.failed",
        version: 1,
        kind: "fact",
        payload: {
          workItemRef: `fixture://${projectId}/no-changes`,
          repositoryId: "main",
          code: "git.no-changes",
          message: expect.stringContaining(`Project ${projectId}`),
          retryable: false,
          workspaceRef: `workspace://${projectId}/${development!.id}`,
        },
      });
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
      expect(
        database.prepare("SELECT 1 FROM inbox WHERE module_instance_id = 'development'").get(),
      ).toBeUndefined();
      expect(
        database
          .prepare(
            "SELECT attempt_count, next_attempt_at FROM deliveries WHERE module_instance_id = 'development'",
          )
          .get(),
      ).toMatchObject({ attempt_count: expect.any(Number), next_attempt_at: expect.any(String) });
      expect(readFailureEvent(database, projectId)).toMatchObject({
        type: "development.implementation.failed",
        payload: {
          workItemRef: `fixture://${projectId}/push-failure`,
          repositoryId: "main",
          code: "git.push-failed",
          message: expect.stringContaining(`Project ${projectId}`),
          retryable: true,
          workspaceRef: `workspace://${projectId}/${development!.id}`,
        },
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

    await activateProject(engine, projectId, fixture, "ignore-terminate");
    const graphResponse = await engine.call(`/v1/projects/${projectId}/graph`);
    expect(graphResponse.status, await graphResponse.clone().text()).toBe(200);
    const graph = (await graphResponse.json()) as {
      nodes: { instanceId: string; enabled: boolean }[];
      edges: {
        kind: string;
        contract: { type: string; version: number; kind: string };
        from: { instanceId: string };
        to?: { instanceId: string };
        routing?: { status: string };
      }[];
      valid: boolean;
      issues: unknown[];
    };
    expect(graph).toMatchObject({ valid: true, issues: [] });
    expect(graph.nodes.map(({ instanceId }) => instanceId)).toEqual([
      "automation-rules",
      "development",
      "request-worker",
    ]);
    expect(graph.nodes.every(({ enabled }) => enabled)).toBe(true);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "request",
          contract: expect.objectContaining({
            type: "development.implementation.requested",
            version: 1,
            kind: "request",
          }),
          from: expect.objectContaining({ instanceId: "automation-rules" }),
          to: expect.objectContaining({ instanceId: "development" }),
          routing: expect.objectContaining({ status: "resolved" }),
        }),
        expect.objectContaining({
          kind: "request",
          contract: expect.objectContaining({
            type: "scm.change-request.creation-requested",
            version: 1,
            kind: "request",
          }),
          from: expect.objectContaining({ instanceId: "development" }),
          to: expect.objectContaining({ instanceId: "request-worker" }),
          routing: expect.objectContaining({ status: "resolved" }),
        }),
      ]),
    );
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
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM events
             WHERE project_id = ?
               AND json_extract(envelope, '$.type') IN ('development.implementation.completed', 'scm.change-request.creation-requested')`,
          )
          .get(projectId),
      ).toEqual({ count: 0 });
      expect(readFailureEvent(database, projectId)).toMatchObject({
        type: "development.implementation.failed",
        payload: {
          workItemRef: `fixture://${projectId}/cancelled`,
          repositoryId: "main",
          code: "agent.run-cancelled",
          message: expect.stringContaining(`Project ${projectId}`),
          retryable: false,
          workspaceRef: `workspace://${projectId}/${running.id}`,
        },
      });
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

    await activateProject(engine, projectId, fixture, "ignore-terminate", 100);
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
      expect(readFailureEvent(database, projectId)).toMatchObject({
        type: "development.implementation.failed",
        payload: {
          workItemRef: `fixture://${projectId}/timed-out`,
          repositoryId: "main",
          code: "agent.run-timed-out",
          message: expect.stringContaining(`Project ${projectId}`),
          retryable: true,
          workspaceRef: `workspace://${projectId}/${timedOut.id}`,
        },
      });
    } finally {
      database.close();
    }
  });

  it("publishes a classified agent runtime failure", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-agent-failure-"));
    roots.push(dataRoot);
    const projectId = "development-agent-failure";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1", JARVIS_FAKE_SCENARIO: "failure" },
    });
    engines.push(engine);

    await activateProject(engine, projectId, fixture, "failure");
    await publishTag(engine, projectId, "agent-failure");
    const executions = await waitForExecutions(engine, projectId, 2);
    const development = executions.find(
      (execution) => execution.moduleInstanceId === "development",
    );
    expect(development).toMatchObject({ status: "failed" });
    expect(development).toBeDefined();

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(readFailureEvent(database, projectId)).toMatchObject({
        type: "development.implementation.failed",
        payload: {
          workItemRef: `fixture://${projectId}/agent-failure`,
          repositoryId: "main",
          code: "agent.run-failed",
          message: expect.stringContaining(`Project ${projectId}`),
          retryable: false,
          workspaceRef: `workspace://${projectId}/${development!.id}`,
        },
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

    await activateProject(engine, projectId, fixture, "oversized", 300_000, 1_024);
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
      expect(
        database
          .prepare(
            "SELECT code, message, attempts FROM dead_letters WHERE module_instance_id = 'development'",
          )
          .get(),
      ).toEqual({ code: "git.validation-failed", message: expect.any(String), attempts: 1 });
      expect(
        database.prepare("SELECT 1 FROM inbox WHERE module_instance_id = 'development'").get(),
      ).toBeUndefined();
      expect(readFailureEvent(database, projectId)).toMatchObject({
        type: "development.implementation.failed",
        payload: {
          workItemRef: `fixture://${projectId}/validation`,
          repositoryId: "main",
          code: "git.validation-failed",
          message: expect.stringContaining(`Project ${projectId}`),
          retryable: false,
          workspaceRef: `workspace://${projectId}/${development!.id}`,
        },
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

  it("repairs a red validation plan within its configured budget", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-repair-success-"));
    roots.push(dataRoot);
    const projectId = "development-repair-success";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1", JARVIS_FAKE_SCENARIO: "repair" },
    });
    engines.push(engine);

    const outputLimitBytes = 1_024;
    await activateProject(
      engine,
      projectId,
      fixture,
      "repair",
      300_000,
      outputLimitBytes,
      {
        test: `node -e "const fs=require('node:fs'); if (!fs.existsSync('validation-fix.txt')) { process.stdout.write(process.cwd() + ' token=repair-secret ' + 'x'.repeat(5000)); process.exit(7); }"`,
      },
      ["test"],
      false,
      "origin",
      1,
    );
    await publishTag(engine, projectId, "repair-success");
    const executions = await waitForExecutions(engine, projectId, 2);
    const development = executions.find(
      (execution) => execution.moduleInstanceId === "development",
    );
    expect(executions).toHaveLength(2);
    expect(development).toMatchObject({ status: "completed" });
    expect(development).toBeDefined();

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      const checkpoints = database
        .prepare(
          "SELECT type, payload FROM execution_checkpoints WHERE execution_id = ? ORDER BY sequence",
        )
        .all(development!.id) as { type: string; payload: string }[];
      expect(checkpoints.map(({ type }) => type)).toEqual([
        "agent.started",
        "agent.message",
        "validation.started",
        "validation.failed",
        "agent.message",
        "validation.started",
        "commit.created",
        "branch.pushed",
      ]);
      const repairMessages = checkpoints
        .filter(({ type }) => type === "agent.message")
        .map(({ payload }) => (JSON.parse(payload) as { message: string }).message)
        .filter((message) => message.includes("Validation failure check: test"));
      expect(repairMessages).toHaveLength(1);
      expect(repairMessages[0]).toContain("Captured validation output:");
      expect(repairMessages[0]).toContain("<workspace>");
      expect(repairMessages[0]).not.toContain(fixture.root);
      expect(repairMessages[0]).not.toContain("repair-secret");
      expect(Buffer.byteLength(repairMessages[0]!, "utf8")).toBeLessThanOrEqual(outputLimitBytes);
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM outbox
             WHERE project_id = ?
               AND json_extract(envelope, '$.type') IN ('development.implementation.completed', 'scm.change-request.creation-requested')`,
          )
          .get(projectId),
      ).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it("stops after the configured number of repair cycles", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-repair-exhausted-"));
    roots.push(dataRoot);
    const projectId = "development-repair-exhausted";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: { JARVIS_ENABLE_TEST_HOOKS: "1", JARVIS_FAKE_SCENARIO: "repair" },
    });
    engines.push(engine);
    const before = repositoryState(fixture.root);

    await activateProject(
      engine,
      projectId,
      fixture,
      "repair",
      300_000,
      1_024,
      {
        test: `node -e "process.stdout.write(process.cwd() + ' token=repair-secret ' + 'x'.repeat(5000)); process.exit(7)"`,
      },
      ["test"],
      false,
      "origin",
      2,
    );
    await publishTag(engine, projectId, "repair-exhausted");
    const executions = await waitForExecutions(engine, projectId, 2);
    const development = executions.find(
      (execution) => execution.moduleInstanceId === "development",
    );
    expect(executions).toHaveLength(2);
    expect(development).toMatchObject({ status: "failed" });
    expect(development).toBeDefined();
    expect(repositoryState(fixture.root)).toEqual(before);

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(
        database
          .prepare(
            "SELECT code, message, attempts FROM dead_letters WHERE module_instance_id = 'development'",
          )
          .get(),
      ).toEqual({ code: "git.validation-failed", message: expect.any(String), attempts: 1 });
      expect(
        database.prepare("SELECT 1 FROM inbox WHERE module_instance_id = 'development'").get(),
      ).toBeUndefined();
      const checkpoints = database
        .prepare(
          "SELECT type, payload FROM execution_checkpoints WHERE execution_id = ? ORDER BY sequence",
        )
        .all(development!.id) as { type: string; payload: string }[];
      expect(checkpoints.map(({ type }) => type)).toEqual([
        "agent.started",
        "agent.message",
        "validation.started",
        "validation.failed",
        "agent.message",
        "validation.started",
        "validation.failed",
        "agent.message",
        "validation.started",
        "validation.failed",
      ]);
      expect(
        checkpoints.filter(
          ({ type, payload }) =>
            type === "agent.message" &&
            (JSON.parse(payload) as { message: string }).message.includes(
              "Validation failure check: test",
            ),
        ),
      ).toHaveLength(2);
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
            "SELECT COUNT(*) AS count FROM workspace_leases WHERE project_id = ? AND status = 'active'",
          )
          .get(projectId),
      ).toEqual({ count: 0 });
      expect(readFailureEvent(database, projectId)).toMatchObject({
        type: "development.implementation.failed",
        payload: {
          workItemRef: `fixture://${projectId}/repair-exhausted`,
          repositoryId: "main",
          code: "git.validation-failed",
          retryable: false,
          workspaceRef: `workspace://${projectId}/${development!.id}`,
        },
      });
    } finally {
      database.close();
    }
  });

  it("cancels a repair run and leaves no child process behind", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join("/tmp", "jarvis-development-repair-cancel-"));
    roots.push(dataRoot);
    const projectId = "development-repair-cancel";
    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: {
        JARVIS_ENABLE_TEST_HOOKS: "1",
        JARVIS_FAKE_SCENARIO: "repair-ignore-terminate",
      },
    });
    engines.push(engine);

    await activateProject(
      engine,
      projectId,
      fixture,
      "repair-ignore-terminate",
      300_000,
      1_048_576,
      { test: `node -e "process.exit(7)"` },
      ["test"],
      false,
      "origin",
      1,
    );
    await publishTag(engine, projectId, "repair-cancel");
    const running = await waitForExecution(engine, projectId, "development", "running");
    const workspacePath = join(dataRoot, "projects", projectId, "workspaces", running.id);
    const childPid = await waitForPid(join(workspacePath, "fake-runtime-repair-child.pid"));

    const response = await engine.call(`/v1/executions/${running.id}/cancel`, { method: "POST" });
    expect(response.status).toBe(202);
    const cancelled = await waitForExecution(engine, projectId, "development", "cancelled");
    expect(cancelled.id).toBe(running.id);
    expect(existsSync(join(workspacePath, "fake-runtime-repair-child-interrupt.txt"))).toBe(true);
    await expectProcessGone(childPid);

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      expect(readFailureEvent(database, projectId)).toMatchObject({
        type: "development.implementation.failed",
        payload: {
          workItemRef: `fixture://${projectId}/repair-cancel`,
          repositoryId: "main",
          code: "agent.run-cancelled",
          retryable: false,
          workspaceRef: `workspace://${projectId}/${running.id}`,
        },
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
      expect(
        database
          .prepare(
            "SELECT code, message, attempts FROM dead_letters WHERE module_instance_id = 'development'",
          )
          .get(),
      ).toEqual({ code: "project.config-invalid", message: expect.any(String), attempts: 1 });
      expect(
        database.prepare("SELECT 1 FROM inbox WHERE module_instance_id = 'development'").get(),
      ).toBeUndefined();
      expect(readFailureEvent(database, projectId)).toMatchObject({
        type: "development.implementation.failed",
        payload: {
          workItemRef: `fixture://${projectId}/missing-command`,
          repositoryId: "main",
          code: "project.config-invalid",
          message: expect.stringContaining(`Project ${projectId}`),
          retryable: false,
          workspaceRef: `workspace://${projectId}/${development!.id}`,
        },
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
  fakeScenario: string | false = false,
  timeoutMs = 300_000,
  outputLimitBytes = 1_048_576,
  commands: PortableProjectConfiguration["commands"] = { test: "node --test" },
  validationOrder: readonly string[] = ["test"],
  retainWorkspaceOnSuccess = false,
  pushRemote = "origin",
  maxRepairCycles = 0,
  runtimeRef = "runtime/fake-test",
): Promise<void> {
  const connection = await engine.call("/v1/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "connection/github-work-items",
      kind: "github",
      displayName: "Work Items",
      secretRef: "gh://WorkItems",
    }),
  });
  expect(connection.status, await connection.clone().text()).toBe(201);
  const validated = await engine.call("/v1/connections/connection%2Fgithub-work-items/validate", {
    method: "POST",
  });
  expect(validated.status, await validated.clone().text()).toBe(200);
  const portableConfig = {
    apiVersion: "jarvis.dev/project/v1",
    kind: "Project",
    metadata: { id: projectId, name: "Development tracer" },
    repositories: [{ id: "main", root: ".", defaultBranch: "main", remote: "origin" }],
    slots: {
      agentRuntime: { requires: "agent.execute" },
      tickets: { requires: "work-items.read" },
    },
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
        bindings: { repository: "main", tickets: "tickets" },
        configuration: {
          validationOrder,
          maxRepairCycles,
          preparation: commands.install === undefined ? "none" : "install",
          retainWorkspaceOnSuccess,
          timeoutMs,
          outputLimitBytes,
          environmentAllowlist:
            runtimeRef === "runtime/codex-default"
              ? ["PATH"]
              : fakeScenario === false
                ? []
                : ["JARVIS_FAKE_SCENARIO"],
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
      slots: {
        agentRuntime: {
          kind: "runtime",
          ref: runtimeRef,
          ...(runtimeRef === "runtime/codex-default"
            ? { environment: { PATH: process.env["PATH"] ?? "/usr/bin" } }
            : fakeScenario !== false
              ? {
                  environment: {
                    JARVIS_FAKE_SCENARIO: fakeScenario,
                  },
                }
              : {}),
        },
        tickets: { kind: "connection", ref: "connection/github-work-items" },
      },
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
  workItemRef = `fixture://${projectId}/${suffix}`,
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
      subject: { type: "work-item", ref: workItemRef },
      correlationId: `corr_${suffix}`,
      causationId: null,
      payload: {
        workItemRef,
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

async function waitForAdmission(
  dataRoot: string,
  projectId: string,
  status: string,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      const row = database
        .prepare("SELECT status FROM development_admissions WHERE project_id = ?")
        .get(projectId) as { status: string } | undefined;
      if (row?.status === status) return;
    } finally {
      database.close();
    }
    if (Date.now() - startedAt > 5_000) throw new Error("Development admission did not settle.");
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

function readFailureEvent(database: Database.Database, projectId: string): Record<string, unknown> {
  const rows = database
    .prepare(
      `SELECT envelope FROM outbox
       WHERE project_id = ? AND json_extract(envelope, '$.type') = 'development.implementation.failed'`,
    )
    .all(projectId) as { envelope: string }[];
  expect(rows).toHaveLength(1);
  const event = JSON.parse(rows[0]!.envelope) as Record<string, unknown>;
  expect(JSON.stringify(event)).not.toMatch(/\/(?:Users|home|private\/var|tmp)\//);
  return event;
}

function git(repositoryPath: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: repositoryPath, encoding: "utf8" }).trim();
}
