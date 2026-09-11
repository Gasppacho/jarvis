import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine, type Harness } from "./harness.js";
import {
  makeRealGitRepositoryFixture,
  type RealGitRepositoryFixture,
} from "./repository-fixture.js";

const testBundlePath = fileURLToPath(
  new URL("../../../dist/engine/engine.test-bundle.mjs", import.meta.url),
);
const started: Harness[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((engine) => engine.dispose()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Workspace allocation durability", () => {
  it("reconciles a crash after Git and reallocates the same execution", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = makeDataRoot();
    const projectId = "project-74-first";
    const executionId = "execution-74";
    const workspacePath = expectedWorkspace(dataRoot, projectId, executionId);

    const crashed = await startWith(dataRoot, "after-worktree-create-before-lease-commit");
    await createProject(crashed, projectId, fixture.root);
    await expectCrash(allocate(crashed, projectId, executionId, fixture), crashed);
    expect(existsSync(workspacePath)).toBe(true);
    expect(readLease(dataRoot, projectId, executionId)).toBeUndefined();
    expect(worktreePaths(fixture.root)).toContain(workspacePath);

    const restarted = await startWith(dataRoot);
    await restarted.waitForStderr("code=workspace.reconciliation.completed");
    expect(existsSync(workspacePath)).toBe(false);
    expect(readLease(dataRoot, projectId, executionId)).toBeUndefined();
    expect(worktreePaths(fixture.root)).not.toContain(workspacePath);

    await stopEngine(restarted);
    const idempotentRestart = await startWith(dataRoot);
    await idempotentRestart.waitForStderr("code=workspace.reconciliation.completed");
    expect(existsSync(workspacePath)).toBe(false);
    expect(readLease(dataRoot, projectId, executionId)).toBeUndefined();
    expect(worktreePaths(fixture.root)).not.toContain(workspacePath);

    const allocation = await allocate(idempotentRestart, projectId, executionId, fixture);
    await expectAllocation(allocation, idempotentRestart, fixture);
    expect(existsSync(workspacePath)).toBe(true);

    await release(idempotentRestart, projectId, executionId, fixture.root);
    await stopEngine(idempotentRestart);
    const secondRestart = await startWith(dataRoot);
    await secondRestart.waitForStderr("code=workspace.reconciliation.completed");
    expect(existsSync(workspacePath)).toBe(false);
    expect(worktreePaths(fixture.root)).not.toContain(workspacePath);
  });

  it("reconciles a crash after the Lease commit and reallocates the same execution", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = makeDataRoot();
    const projectId = "project-74-second";
    const executionId = "execution-74";
    const workspacePath = expectedWorkspace(dataRoot, projectId, executionId);

    const crashed = await startWith(dataRoot, "after-lease-commit-before-response");
    await createProject(crashed, projectId, fixture.root);
    await expectCrash(allocate(crashed, projectId, executionId, fixture), crashed);
    expect(existsSync(workspacePath)).toBe(true);
    expect(readLease(dataRoot, projectId, executionId)?.status).toBe("active");
    expect(worktreePaths(fixture.root)).toContain(workspacePath);

    const restarted = await startWith(dataRoot);
    await restarted.waitForStderr("code=workspace.reconciliation.completed");
    expect(existsSync(workspacePath)).toBe(false);
    expect(readLease(dataRoot, projectId, executionId)?.status).toBe("released");
    expect(worktreePaths(fixture.root)).not.toContain(workspacePath);

    await stopEngine(restarted);
    const idempotentRestart = await startWith(dataRoot);
    await idempotentRestart.waitForStderr("code=workspace.reconciliation.completed");
    expect(existsSync(workspacePath)).toBe(false);
    expect(readLease(dataRoot, projectId, executionId)?.status).toBe("released");
    expect(worktreePaths(fixture.root)).not.toContain(workspacePath);

    await expectAllocation(
      await allocate(idempotentRestart, projectId, executionId, fixture),
      idempotentRestart,
      fixture,
    );
    await release(idempotentRestart, projectId, executionId, fixture.root);
    await stopEngine(idempotentRestart);

    const secondRestart = await startWith(dataRoot);
    await secondRestart.waitForStderr("code=workspace.reconciliation.completed");
    expect(readLease(dataRoot, projectId, executionId)?.status).toBe("released");
    expect(worktreePaths(fixture.root)).not.toContain(workspacePath);
  });

  it("leaves no residue when it crashes before the first Git call", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = makeDataRoot();
    const projectId = "project-74-before-git";
    const executionId = "execution-74";
    const workspacePath = expectedWorkspace(dataRoot, projectId, executionId);

    const crashed = await startWith(dataRoot, "before-first-git-call");
    await createProject(crashed, projectId, fixture.root);
    await expectCrash(allocate(crashed, projectId, executionId, fixture), crashed);
    expect(existsSync(workspacePath)).toBe(false);
    expect(readLease(dataRoot, projectId, executionId)).toBeUndefined();
    expect(worktreePaths(fixture.root)).not.toContain(workspacePath);

    const restarted = await startWith(dataRoot);
    await restarted.waitForStderr("code=workspace.reconciliation.completed");
    await expectAllocation(
      await allocate(restarted, projectId, executionId, fixture),
      restarted,
      fixture,
    );
  });

  it("allocates and releases normally with no failpoint", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = makeDataRoot();
    const projectId = "project-74-normal";
    const executionId = "execution-74";

    const engine = await startWith(dataRoot);
    await createProject(engine, projectId, fixture.root);
    const allocation = await allocate(engine, projectId, executionId, fixture);
    expect(allocation.status).toBe(201);
    const body = (await allocation.json()) as { path: string };
    expect(existsSync(body.path)).toBe(true);
    expect(worktreePaths(fixture.root)).toContain(body.path);

    await release(engine, projectId, executionId, fixture.root);
    expect(existsSync(body.path)).toBe(false);
    expect(worktreePaths(fixture.root)).not.toContain(body.path);
  });
});

function makeDataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-workspace-allocation-"));
  roots.push(root);
  return root;
}

async function startWith(dataRoot: string, failpoint?: string): Promise<Harness> {
  const engine = await startEngine({
    dataRoot,
    enginePath: testBundlePath,
    env: {
      JARVIS_ENABLE_TEST_HOOKS: "1",
      ...(failpoint === undefined ? {} : { JARVIS_FAILPOINT: failpoint }),
    },
  });
  started.push(engine);
  return engine;
}

async function createProject(
  engine: Harness,
  projectId: string,
  repositoryPath: string,
): Promise<void> {
  const response = await engine.call("/test/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: projectId, repositoryPath }),
  });
  expect(response.status).toBe(201);
}

function allocate(
  engine: Harness,
  projectId: string,
  executionId: string,
  fixture: RealGitRepositoryFixture,
): Promise<Response> {
  return engine.call("/test/workspaces/allocate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId,
      executionId,
      repositoryId: "main",
      repositoryPath: fixture.root,
      baseRevision: fixture.commitSha,
      branchContext: { workItemId: "74", slug: "crash-safe" },
    }),
  });
}

async function release(
  engine: Harness,
  projectId: string,
  executionId: string,
  repositoryPath: string,
): Promise<void> {
  const response = await engine.call("/test/workspaces/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, executionId, repositoryPath, outcome: "success" }),
  });
  expect(response.status).toBe(200);
}

async function stopEngine(engine: Harness): Promise<void> {
  const response = await engine.call("/v1/system/shutdown", { method: "POST" });
  expect(response.status).toBe(202);
  await expect(engine.waitForExit()).resolves.toBe(0);
}

async function expectCrash(request: Promise<Response>, engine: Harness): Promise<void> {
  await request.catch(() => undefined);
  await expect(engine.waitForExit()).resolves.not.toBe(0);
  await engine.dispose();
}

async function expectAllocation(
  response: Response,
  engine: Harness,
  fixture: RealGitRepositoryFixture,
): Promise<void> {
  if (response.status !== 201) {
    throw new Error(
      `allocation failed with HTTP ${response.status}: ${await response.text()}\n${engine.stderr()}\n` +
        `branches:\n${execFileSync("git", ["branch", "--list"], { cwd: fixture.root, encoding: "utf8" })}\n` +
        `worktrees:\n${worktreePaths(fixture.root)}`,
    );
  }
}

function expectedWorkspace(dataRoot: string, projectId: string, executionId: string): string {
  return join(realpathSync(dataRoot), "projects", projectId, "workspaces", executionId);
}

function worktreePaths(repositoryPath: string): string {
  return execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repositoryPath,
    encoding: "utf8",
  });
}

function readLease(
  dataRoot: string,
  projectId: string,
  executionId: string,
): { status: string } | undefined {
  const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
  try {
    return database
      .prepare(
        `SELECT status FROM workspace_leases
         WHERE project_id = ? AND execution_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId, executionId) as { status: string } | undefined;
  } finally {
    database.close();
  }
}
