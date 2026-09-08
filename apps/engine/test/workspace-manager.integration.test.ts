import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SystemIdGenerator } from "../../../packages/kernel/src/id-generator.js";
import { SystemClock } from "../../../packages/kernel/src/clock.js";
import {
  WorkspaceManager,
  type WorkspaceProjectConfiguration,
} from "../../../packages/workspace/src/workspace-manager.js";
import { WorkspaceLeaseRepository } from "../../../packages/workspace/src/lease-repository.js";
import { GitRunner } from "../../../packages/workspace/src/git-runner.js";
import { applyMigrations } from "../src/db/test-migrations.js";
import { makeRealGitRepositoryFixture } from "./repository-fixture.js";

const roots: string[] = [];
const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("WorkspaceManager allocation", () => {
  it("allocates a clean worktree from the explicit base and commits one active lease", async () => {
    const fixture = makeRealGitRepositoryFixture();
    roots.push(fixture.root);
    const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-workspace-manager-"));
    roots.push(dataRoot);
    const database = new Database(join(dataRoot, "jarvis.sqlite"));
    databases.push(database);
    database.pragma("foreign_keys = ON");
    applyMigrations(database);

    const projectId = "project-69";
    const executionId = "exec-69";
    const project: WorkspaceProjectConfiguration = {
      git: { branchPattern: "agent/{workItemId}-{slug}" },
      workspace: { retainOnFailureDays: 7 },
    };
    database
      .prepare(
        `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
         VALUES (@id, @name, 'active', @config, @now, @now)`,
      )
      .run({
        id: projectId,
        name: projectId,
        config: JSON.stringify(project),
        now: "2026-09-08T10:00:00.000Z",
      });

    const secondCommitFile = join(fixture.root, "main-only.txt");
    writeFileSync(secondCommitFile, "main checkout only\n", "utf8");
    execFileSync("git", ["add", "main-only.txt"], { cwd: fixture.root, stdio: "ignore" });
    execFileSync("git", ["commit", "--quiet", "--no-gpg-sign", "-m", "Main update"], {
      cwd: fixture.root,
      stdio: "ignore",
    });
    const mainHeadBefore = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.root,
      encoding: "utf8",
    }).trim();
    const mainBranchBefore = execFileSync("git", ["branch", "--show-current"], {
      cwd: fixture.root,
      encoding: "utf8",
    }).trim();
    const mainChange = join(fixture.root, "uncommitted-main.txt");
    writeFileSync(mainChange, "must not be inherited\n", "utf8");
    const mainStatusBefore = execFileSync("git", ["status", "--porcelain"], {
      cwd: fixture.root,
      encoding: "utf8",
    });

    const leases = new WorkspaceLeaseRepository(
      database,
      new SystemClock(),
      new SystemIdGenerator(),
    );
    const manager = new WorkspaceManager({ dataRoot, leases });

    const allocation = await manager.allocate({
      projectId,
      executionId,
      repositoryId: "main",
      repositoryPath: fixture.root,
      baseRevision: fixture.commitSha,
      branchContext: { workItemId: "69", slug: "isolated-worktree" },
      project,
    });

    const expectedPath = join(
      realpathSync(dataRoot),
      "projects",
      projectId,
      "workspaces",
      executionId,
    );
    expect(allocation).toMatchObject({
      path: expectedPath,
      workingBranch: "agent/69-isolated-worktree",
      baseRevisionSha: fixture.commitSha,
    });
    expect(existsSync(expectedPath)).toBe(true);
    expect(existsSync(join(expectedPath, "uncommitted-main.txt"))).toBe(false);
    expect(existsSync(join(expectedPath, "main-only.txt"))).toBe(false);

    const workspaceGit = new GitRunner({ cwd: expectedPath });
    await expect(workspaceGit.run(["rev-parse", "HEAD"])).resolves.toMatchObject({
      ok: true,
      stdout: `${fixture.commitSha}\n`,
    });
    await expect(workspaceGit.run(["branch", "--show-current"])).resolves.toMatchObject({
      ok: true,
      stdout: "agent/69-isolated-worktree\n",
    });
    await expect(workspaceGit.run(["status", "--porcelain"])).resolves.toMatchObject({
      ok: true,
      stdout: "",
    });

    expect(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.root, encoding: "utf8" }).trim(),
    ).toBe(mainHeadBefore);
    expect(
      execFileSync("git", ["branch", "--show-current"], {
        cwd: fixture.root,
        encoding: "utf8",
      }).trim(),
    ).toBe(mainBranchBefore);
    expect(
      execFileSync("git", ["status", "--porcelain"], { cwd: fixture.root, encoding: "utf8" }),
    ).toBe(mainStatusBefore);

    const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: fixture.root,
      encoding: "utf8",
    });
    expect(worktrees).toContain(`worktree ${expectedPath}`);
    expect(worktrees).toContain(`HEAD ${fixture.commitSha}`);
    expect(worktrees).toContain("branch refs/heads/agent/69-isolated-worktree");

    const lease = leases.findByExecution(projectId, executionId);
    expect(lease).toMatchObject({
      projectId,
      executionId,
      repositoryId: "main",
      workingBranch: "agent/69-isolated-worktree",
      baseRevisionSha: fixture.commitSha,
      workspacePath: expectedPath,
      status: "active",
      cleanupPolicy: "retain-on-failure",
    });
    expect(leases.listActive(projectId)).toHaveLength(1);
    expect(allocation.lease).toEqual(lease);
  });
});
