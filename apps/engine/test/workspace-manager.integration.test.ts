import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SystemIdGenerator } from "../../../packages/kernel/src/id-generator.js";
import { SystemClock } from "../../../packages/kernel/src/clock.js";
import {
  WorkspaceAllocationError,
  type AllocateWorkspaceInput,
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
      workspace: { maxConcurrentExecutions: 1, retainOnFailureDays: 7 },
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

  it("returns the existing workspace when the same execution allocates twice", async () => {
    const harness = makeHarness();

    const first = await harness.manager.allocate(harness.input);
    const second = await harness.manager.allocate(harness.input);

    expect(second).toEqual(first);
    expect(harness.leases.listActive(harness.input.projectId)).toEqual([first.lease]);
    expect(repositoryWorktreeCount(harness.fixture.root)).toBe(2);
  });

  it("uses the durable branch lease to elect one winner for concurrent allocations", async () => {
    const harness = makeHarness({
      project: {
        git: { branchPattern: "agent/{workItemId}" },
        workspace: { maxConcurrentExecutions: 2, retainOnFailureDays: 7 },
      },
    });
    const inputs = [
      {
        ...harness.input,
        executionId: "exec-71-a",
        branchContext: { workItemId: "71", slug: "same-branch" },
      },
      {
        ...harness.input,
        executionId: "exec-71-b",
        branchContext: { workItemId: "71", slug: "same-branch" },
      },
    ];

    const outcomes = await Promise.all(
      inputs.map(async (input) => {
        try {
          return { input, allocation: await harness.manager.allocate(input) } as const;
        } catch (error: unknown) {
          return { input, error } as const;
        }
      }),
    );
    const winner = outcomes.find((outcome) => "allocation" in outcome);
    const loser = outcomes.find((outcome) => "error" in outcome);

    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    if (winner === undefined || loser === undefined || !("allocation" in winner)) {
      throw new Error("expected one successful concurrent allocation");
    }
    if (!("error" in loser)) throw new Error("expected one rejected concurrent allocation");

    expect(loser.error).toMatchObject({
      code: "workspace.branch-conflict",
      failureClass: "workspace",
      retryable: false,
    });
    const loserExecutionId = loser.input.executionId;
    expect(
      harness.leases.findByExecution(harness.input.projectId, loserExecutionId),
    ).toBeUndefined();
    expect(
      existsSync(
        join(
          realpathSync(harness.dataRoot),
          "projects",
          harness.input.projectId,
          "workspaces",
          loserExecutionId,
        ),
      ),
    ).toBe(false);
    expect(harness.leases.listActive(harness.input.projectId)).toEqual([winner.allocation.lease]);
    expect(repositoryWorktreeCount(harness.fixture.root)).toBe(2);
  });

  it("refuses allocations over the project limit and reuses a slot after release", async () => {
    const harness = makeHarness({
      project: {
        git: { branchPattern: "agent/{workItemId}-{slug}" },
        workspace: { maxConcurrentExecutions: 1, retainOnFailureDays: 7 },
      },
    });
    const first = await harness.manager.allocate(harness.input);
    const secondInput = {
      ...harness.input,
      executionId: "exec-71-second",
      branchContext: { workItemId: "71", slug: "second" },
    };

    const error = await expectWorkspaceFailure(
      harness,
      { code: "workspace.concurrency-limit", retryable: false },
      secondInput,
    );

    expect(error.message).toContain("1");
    expect(error.details).toMatchObject({ maxConcurrentExecutions: 1 });
    expect(harness.leases.findByExecution(harness.input.projectId, secondInput.executionId)).toBe(
      undefined,
    );
    expect(
      existsSync(
        join(
          realpathSync(harness.dataRoot),
          "projects",
          harness.input.projectId,
          "workspaces",
          secondInput.executionId,
        ),
      ),
    ).toBe(false);

    expect(harness.leases.release(harness.input.projectId, first.lease.id)).toMatchObject({
      status: "released",
    });
    await expect(harness.manager.allocate(secondInput)).resolves.toMatchObject({
      workingBranch: "agent/71-second",
    });
  });

  it("counts active workspace leases independently for each project", async () => {
    const harness = makeHarness({
      project: {
        git: { branchPattern: "agent/{workItemId}-{slug}" },
        workspace: { maxConcurrentExecutions: 1, retainOnFailureDays: 7 },
      },
    });
    await harness.manager.allocate(harness.input);
    const otherProjectId = "project-71-other";
    seedProject(harness.database, otherProjectId, harness.project);

    const otherAllocation = await harness.manager.allocate({
      ...harness.input,
      projectId: otherProjectId,
      executionId: "exec-71-other",
      branchContext: { workItemId: "71-other", slug: "separate-project" },
    });

    expect(otherAllocation.lease.projectId).toBe(otherProjectId);
    expect(harness.leases.listActive(harness.input.projectId)).toHaveLength(1);
    expect(harness.leases.listActive(otherProjectId)).toHaveLength(1);
  });

  it("refuses an unknown base revision before creating workspace state", async () => {
    const harness = makeHarness();
    const before = repositoryState(harness.fixture.root);

    await expectWorkspaceFailure(
      harness,
      { code: "git.base-not-found", retryable: false },
      { ...harness.input, baseRevision: "refs/heads/missing" },
    );

    expect(existsSync(harness.expectedPath)).toBe(false);
    expect(harness.leases.findByExecution(harness.input.projectId, harness.input.executionId)).toBe(
      undefined,
    );
    expect(repositoryState(harness.fixture.root)).toEqual(before);
  });

  it("refuses a non-empty target path before reusing it", async () => {
    const harness = makeHarness();
    mkdirSync(harness.expectedPath, { recursive: true });
    writeFileSync(join(harness.expectedPath, "do-not-touch.txt"), "existing\n", "utf8");
    const before = repositoryState(harness.fixture.root);

    await expectWorkspaceFailure(harness, {
      code: "workspace.allocation-failed",
      retryable: false,
    });

    expect(existsSync(join(harness.expectedPath, "do-not-touch.txt"))).toBe(true);
    expect(repositoryState(harness.fixture.root)).toEqual(before);
  });

  it("refuses a working branch that already exists", async () => {
    const harness = makeHarness();
    execFileSync("git", ["branch", harness.workingBranch, harness.fixture.commitSha], {
      cwd: harness.fixture.root,
      stdio: "ignore",
    });
    const before = repositoryState(harness.fixture.root);

    await expectWorkspaceFailure(harness, {
      code: "workspace.allocation-failed",
      retryable: false,
    });

    expect(existsSync(harness.expectedPath)).toBe(false);
    expect(repositoryState(harness.fixture.root)).toEqual(before);
  });

  it("refuses a working branch checked out in another worktree", async () => {
    const harness = makeHarness();
    const otherWorkspace = join(harness.dataRoot, "already-checked-out");
    execFileSync(
      "git",
      [
        "worktree",
        "add",
        "--quiet",
        "-b",
        harness.workingBranch,
        otherWorkspace,
        harness.fixture.commitSha,
      ],
      { cwd: harness.fixture.root, stdio: "ignore" },
    );
    const before = repositoryState(harness.fixture.root);

    await expectWorkspaceFailure(harness, {
      code: "workspace.allocation-failed",
      retryable: false,
    });

    expect(existsSync(harness.expectedPath)).toBe(false);
    expect(existsSync(otherWorkspace)).toBe(true);
    expect(repositoryState(harness.fixture.root)).toEqual(before);
  });

  it("rejects identifier traversal before touching the workspaces root", async () => {
    const harness = makeHarness();
    const input = { ...harness.input, projectId: "../outside" };

    await expectWorkspaceFailure(
      harness,
      { code: "workspace.path-violation", retryable: false },
      input,
    );

    expect(existsSync(join(harness.dataRoot, "projects"))).toBe(false);
    expect(existsSync(join(harness.dataRoot, "outside"))).toBe(false);
  });

  it("rejects branch-name traversal before touching the workspaces root", async () => {
    const harness = makeHarness({
      project: {
        git: { branchPattern: "../outside/{workItemId}" },
        workspace: { maxConcurrentExecutions: 1, retainOnFailureDays: 7 },
      },
    });

    await expectWorkspaceFailure(harness, { code: "workspace.path-violation", retryable: false });

    expect(existsSync(join(harness.dataRoot, "projects"))).toBe(false);
  });

  it.each([
    ["missing", "missing-repository"],
    ["non-Git", "plain-repository"],
  ])("refuses a %s repository", async (_label, repositoryName) => {
    const harness = makeHarness();
    const repositoryPath = join(harness.dataRoot, repositoryName);
    if (repositoryName === "plain-repository") mkdirSync(repositoryPath);

    await expectWorkspaceFailure(
      harness,
      { code: "workspace.allocation-failed", retryable: false },
      { ...harness.input, repositoryPath },
    );

    expect(existsSync(harness.expectedPath)).toBe(false);
  });

  it("refuses an unreadable repository", async () => {
    const harness = makeHarness();
    chmodSync(harness.fixture.root, 0o000);
    try {
      await expectWorkspaceFailure(harness, {
        code: "workspace.allocation-failed",
        retryable: false,
      });
    } finally {
      chmodSync(harness.fixture.root, 0o755);
    }

    expect(existsSync(harness.expectedPath)).toBe(false);
  });

  it("turns a missing Git executable into a typed failure", async () => {
    const missingGitRoot = mkdtempSync(join(tmpdir(), "jarvis-workspace-manager-git-"));
    roots.push(missingGitRoot);
    const harness = makeHarness({ gitExecutable: join(missingGitRoot, "missing-git") });

    await expectWorkspaceFailure(harness, { code: "workspace.allocation-failed", retryable: true });

    expect(existsSync(harness.expectedPath)).toBe(false);
  });

  it("refuses a branch already claimed by a durable lease before touching Git", async () => {
    const harness = makeHarness();
    const existingLease = harness.leases.create({
      projectId: harness.input.projectId,
      executionId: "other-execution",
      repositoryId: harness.input.repositoryId,
      workingBranch: harness.workingBranch,
      baseRevisionSha: harness.fixture.commitSha,
      workspacePath: join(harness.dataRoot, "other-lease"),
      expiresAt: "9999-12-31T23:59:59.999Z",
      cleanupPolicy: "retain-on-failure",
    });
    const before = repositoryState(harness.fixture.root);

    await expectWorkspaceFailure(harness, {
      code: "workspace.branch-conflict",
      retryable: false,
    });

    expect(harness.leases.findByExecution(harness.input.projectId, harness.input.executionId)).toBe(
      undefined,
    );
    expect(
      harness.leases.findByExecution(harness.input.projectId, existingLease.executionId),
    ).toEqual(existingLease);
    expect(existsSync(harness.expectedPath)).toBe(false);
    expect(repositoryState(harness.fixture.root)).toEqual(before);
  });
});

interface AllocationHarness {
  readonly fixture: ReturnType<typeof makeRealGitRepositoryFixture>;
  readonly dataRoot: string;
  readonly database: Database.Database;
  readonly leases: WorkspaceLeaseRepository;
  readonly manager: WorkspaceManager;
  readonly input: AllocateWorkspaceInput;
  readonly project: WorkspaceProjectConfiguration;
  readonly expectedPath: string;
  readonly workingBranch: string;
}

function makeHarness(
  options: {
    readonly project?: WorkspaceProjectConfiguration;
    readonly gitExecutable?: string;
    readonly projectId?: string;
    readonly executionId?: string;
  } = {},
): AllocationHarness {
  const fixture = makeRealGitRepositoryFixture();
  roots.push(fixture.root);
  const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-workspace-manager-failure-"));
  roots.push(dataRoot);
  const database = new Database(join(dataRoot, "jarvis.sqlite"));
  databases.push(database);
  database.pragma("foreign_keys = ON");
  applyMigrations(database);

  const projectId = options.projectId ?? "project-70";
  const executionId = options.executionId ?? "exec-70";
  const project =
    options.project ??
    ({
      git: { branchPattern: "agent/{workItemId}-{slug}" },
      workspace: { maxConcurrentExecutions: 1, retainOnFailureDays: 7 },
    } satisfies WorkspaceProjectConfiguration);
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

  const leases = new WorkspaceLeaseRepository(database, new SystemClock(), new SystemIdGenerator());
  const manager = new WorkspaceManager({
    dataRoot,
    leases,
    ...(options.gitExecutable === undefined ? {} : { gitExecutable: options.gitExecutable }),
  });
  const input: AllocateWorkspaceInput = {
    projectId,
    executionId,
    repositoryId: "main",
    repositoryPath: fixture.root,
    baseRevision: fixture.commitSha,
    branchContext: { workItemId: "70", slug: "unsafe-path" },
    project,
  };
  const workingBranch = "agent/70-unsafe-path";

  return {
    fixture,
    dataRoot,
    database,
    leases,
    manager,
    input,
    project,
    expectedPath: join(realpathSync(dataRoot), "projects", projectId, "workspaces", executionId),
    workingBranch,
  };
}

async function expectWorkspaceFailure(
  harness: AllocationHarness,
  expected: { readonly code: string; readonly retryable: boolean },
  input: AllocateWorkspaceInput = harness.input,
): Promise<WorkspaceAllocationError> {
  let caught: unknown;
  try {
    await harness.manager.allocate(input);
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkspaceAllocationError);
  expect(caught).toMatchObject({
    code: expected.code,
    failureClass: "workspace",
    retryable: expected.retryable,
  });
  const error = caught as WorkspaceAllocationError;
  expect(error.details).toEqual(expect.any(Object));
  expect(error.message).not.toContain(harness.fixture.root);
  expect(JSON.stringify(error.details)).not.toContain(harness.fixture.root);
  return error;
}

function repositoryState(root: string): Record<string, string> {
  return {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }),
    branch: execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }),
    status: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }),
    refs: execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/heads"], {
      cwd: root,
      encoding: "utf8",
    }),
    worktrees: execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }),
  };
}

function repositoryWorktreeCount(root: string): number {
  return (
    execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).match(/^worktree /gm) ?? []
  ).length;
}

function seedProject(
  database: Database.Database,
  projectId: string,
  project: WorkspaceProjectConfiguration,
): void {
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
}
