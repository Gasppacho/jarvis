import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SystemClock } from "../../../packages/kernel/src/clock.js";
import { SystemIdGenerator } from "../../../packages/kernel/src/id-generator.js";
import {
  WorkspaceLeaseRepository,
  type WorkspaceLease,
} from "../../../packages/workspace/src/lease-repository.js";
import {
  WorkspaceManager,
  type WorkspaceProjectConfiguration,
} from "../../../packages/workspace/src/workspace-manager.js";
import { openDatabase } from "../src/db/open.js";
import { startEngine, type Harness } from "./harness.js";
import { makeRealGitRepositoryFixture } from "./repository-fixture.js";

const started: Harness[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((engine) => engine.dispose()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace reconciliation at engine startup", () => {
  it("cleans leftover leases and directories, preserves valid retention, and is restart-safe", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root, fixture.remoteRoot);
    const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-reconciliation-"));
    roots.push(dataRoot);
    const projectId = "project-73";
    const seeded = seedProject(dataRoot, projectId, fixture.root);

    const active = await seeded.manager.allocate(
      allocationInput(projectId, "exec-active", "active", fixture, seeded.project),
    );
    const expired = await seeded.manager.allocate(
      allocationInput(projectId, "exec-expired", "expired", fixture, seeded.project),
    );
    const expiredLease = seeded.leases.markRetained(
      projectId,
      expired.lease.id,
      new Date(Date.now() - 60_000).toISOString(),
    );
    if (expiredLease === undefined) throw new Error("expected an expired retained lease");

    const retained = await seeded.manager.allocate(
      allocationInput(projectId, "exec-retained", "retained", fixture, seeded.project),
    );
    const retainedLease = seeded.leases.markRetained(
      projectId,
      retained.lease.id,
      new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    );
    if (retainedLease === undefined) throw new Error("expected a valid retained lease");

    const missing = await seeded.manager.allocate(
      allocationInput(projectId, "exec-missing", "missing", fixture, seeded.project),
    );
    rmSync(missing.path, { recursive: true, force: true });

    const workspaceRoot = join(realpathSync(dataRoot), "projects", projectId, "workspaces");
    const orphanWorktree = join(workspaceRoot, "orphan-worktree");
    execFileSync("git", ["worktree", "add", "--quiet", orphanWorktree, fixture.commitSha], {
      cwd: fixture.root,
      stdio: "ignore",
    });
    const orphanDirectory = join(workspaceRoot, "orphan-directory");
    mkdirSync(orphanDirectory, { recursive: true });
    writeFileSync(join(orphanDirectory, "leftover.txt"), "leftover\n", "utf8");
    seeded.database.close();

    const first = await startEngine({ dataRoot });
    started.push(first);
    await first.waitForStderr("code=workspace.reconciliation.completed");

    expect(first.stderr()).toContain("project=project-73");
    expect(first.stderr()).toContain("workspace.reconciliation.active-lease-closed");
    expect(first.stderr()).toContain("workspace.reconciliation.expired-retained-lease-closed");
    expect(first.stderr()).toContain("workspace.reconciliation.lease-without-directory-closed");
    expect(first.stderr()).toContain("workspace.reconciliation.orphan-directory-removed");
    expect(first.stderr()).toContain("workspace.reconciliation.retained-lease-kept");
    expect(first.stderr()).not.toContain(dataRoot);
    expect(first.stderr()).not.toContain(fixture.root);

    await stopEngine(first);

    expect(existsSync(active.path)).toBe(false);
    expect(existsSync(expired.path)).toBe(false);
    expect(existsSync(missing.path)).toBe(false);
    expect(existsSync(retained.path)).toBe(true);
    expect(existsSync(orphanWorktree)).toBe(false);
    expect(existsSync(orphanDirectory)).toBe(false);

    const worktrees = gitWorktrees(fixture.root);
    expect(worktrees).toContain(`worktree ${retained.path}`);
    expect(worktrees).not.toContain(active.path);
    expect(worktrees).not.toContain(expired.path);
    expect(worktrees).not.toContain(orphanWorktree);
    expect((worktrees.match(/^worktree /gm) ?? []).length).toBe(2);

    const firstRows = readLeases(dataRoot);
    expect(firstRows.find((row) => row.execution_id === active.lease.executionId)?.status).toBe(
      "released",
    );
    expect(firstRows.find((row) => row.execution_id === expired.lease.executionId)?.status).toBe(
      "released",
    );
    expect(firstRows.find((row) => row.execution_id === missing.lease.executionId)?.status).toBe(
      "released",
    );
    expect(firstRows.find((row) => row.execution_id === retained.lease.executionId)).toEqual(
      expect.objectContaining({
        status: "retained",
        expires_at: retainedLease.expiresAt,
        updated_at: retainedLease.updatedAt,
      }),
    );

    const second = await startEngine({ dataRoot });
    started.push(second);
    await second.waitForStderr("code=workspace.reconciliation.completed");
    expect(second.stderr()).toContain("workspace.reconciliation.retained-lease-kept");
    expect(second.stderr()).not.toContain(dataRoot);
    expect(second.stderr()).not.toContain(fixture.root);
    await stopEngine(second);

    expect(
      readLeases(dataRoot).find((row) => row.execution_id === retained.lease.executionId),
    ).toEqual(
      expect.objectContaining({
        status: "retained",
        expires_at: retainedLease.expiresAt,
        updated_at: retainedLease.updatedAt,
      }),
    );
  });

  it("reports one unreadable repository and continues with other projects", async () => {
    const goodFixture = makeRealGitRepositoryFixture();
    roots.push(goodFixture.root, goodFixture.remoteRoot);
    const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-reconciliation-failure-"));
    roots.push(dataRoot);
    const good = seedProject(dataRoot, "project-73-good", goodFixture.root);
    const goodAllocation = await good.manager.allocate(
      allocationInput("project-73-good", "exec-good", "good", goodFixture, good.project),
    );

    const badRepository = join(dataRoot, "missing-repository");
    insertProject(good.database, "project-73-bad", badRepository);
    const badLeases = new WorkspaceLeaseRepository(
      good.database,
      new SystemClock(),
      new SystemIdGenerator(),
    );
    const badPath = join(
      realpathSync(dataRoot),
      "projects",
      "project-73-bad",
      "workspaces",
      "exec-bad",
    );
    mkdirSync(badPath, { recursive: true });
    badLeases.create({
      projectId: "project-73-bad",
      executionId: "exec-bad",
      repositoryId: "main",
      workingBranch: "agent/73-bad",
      baseRevisionSha: "a".repeat(40),
      workspacePath: badPath,
      expiresAt: "9999-12-31T23:59:59.999Z",
      cleanupPolicy: "retain-on-failure",
    });
    good.database.close();

    const engine = await startEngine({ dataRoot });
    started.push(engine);
    await engine.waitForStderr("code=workspace.reconciliation.completed");

    expect(existsSync(goodAllocation.path)).toBe(false);
    expect(readLeases(dataRoot).find((row) => row.execution_id === "exec-good")?.status).toBe(
      "released",
    );
    expect(readLeases(dataRoot).find((row) => row.execution_id === "exec-bad")?.status).toBe(
      "released",
    );
    expect(existsSync(badPath)).toBe(false);
    expect(engine.stderr()).toContain("project=project-73-bad");
    expect(engine.stderr()).toContain("workspace.reconciliation.lease-cleanup-failed");
    expect(engine.stderr()).toContain("workspace.reconciliation.repository-unavailable");
    expect(engine.stderr()).toContain("project-73-good");
    expect(engine.stderr()).not.toContain(dataRoot);
    expect(engine.stderr()).not.toContain(goodFixture.root);
  });
});

const projectConfiguration = {
  apiVersion: "jarvis.dev/project/v1",
  kind: "Project",
  metadata: { id: "project-73", name: "Workspace reconciliation" },
  repositories: [{ id: "main", root: ".", defaultBranch: "main", remote: "fixture" }],
  slots: {},
  commands: {},
  git: {
    branchPattern: "agent/{workItemId}-{slug}",
    commitStrategy: "conventional",
    pushRemote: "origin",
    allowForcePush: false,
  },
  workspace: {
    strategy: "git-worktree",
    maxConcurrentExecutions: 10,
    retainOnFailureDays: 7,
  },
  modules: [],
};

function seedProject(
  dataRoot: string,
  projectId: string,
  repositoryPath: string,
): {
  readonly database: Database.Database;
  readonly leases: WorkspaceLeaseRepository;
  readonly manager: WorkspaceManager;
  readonly project: WorkspaceProjectConfiguration;
} {
  const database = openDatabase(join(dataRoot, "jarvis.sqlite")).db;
  const project = { ...projectConfiguration, metadata: { id: projectId, name: projectId } };
  insertProject(database, projectId, repositoryPath, project);
  const clock = new SystemClock();
  const leases = new WorkspaceLeaseRepository(database, clock, new SystemIdGenerator());
  const manager = new WorkspaceManager({ dataRoot, leases, clock });
  return { database, leases, manager, project };
}

function insertProject(
  database: Database.Database,
  projectId: string,
  repositoryPath: string,
  project: typeof projectConfiguration = {
    ...projectConfiguration,
    metadata: { id: projectId, name: projectId },
  },
): void {
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
       VALUES (@id, @name, 'active', @config, @now, @now)`,
    )
    .run({ id: projectId, name: projectId, config: JSON.stringify(project), now });
  database
    .prepare(
      `INSERT INTO project_bindings (project_id, repository_path, bookmark_ref, slot_bindings)
       VALUES (@id, @path, NULL, '{}')`,
    )
    .run({ id: projectId, path: repositoryPath });
}

function allocationInput(
  projectId: string,
  executionId: string,
  slug: string,
  fixture: { readonly commitSha: string; readonly root: string },
  project: WorkspaceProjectConfiguration,
) {
  return {
    projectId,
    executionId,
    repositoryId: "main",
    repositoryPath: fixture.root,
    baseRevision: fixture.commitSha,
    branchContext: { workItemId: "73", slug },
    project,
  };
}

function gitWorktrees(repositoryPath: string): string {
  return execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repositoryPath,
    encoding: "utf8",
  });
}

interface LeaseRow {
  readonly execution_id: string;
  readonly status: string;
  readonly expires_at: string;
  readonly updated_at: string;
}

function readLeases(dataRoot: string): readonly LeaseRow[] {
  const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
  try {
    return database
      .prepare(
        `SELECT execution_id, status, expires_at, updated_at
         FROM workspace_leases
         ORDER BY execution_id`,
      )
      .all() as LeaseRow[];
  } finally {
    database.close();
  }
}

async function stopEngine(engine: Harness): Promise<void> {
  const response = await engine.call("/v1/system/shutdown", { method: "POST" });
  expect(response.status).toBe(202);
  await expect(engine.waitForExit()).resolves.toBe(0);
}
