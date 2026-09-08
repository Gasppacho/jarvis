import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, applyMigrations } from "../src/db/test-migrations.js";
import { WorkspaceLeaseRepository } from "../../../packages/workspace/src/lease-repository.js";

const roots: string[] = [];
const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace lease migration", () => {
  it("creates the schema from empty and from the previous migration snapshot", () => {
    const latest = openDatabase();
    expectWorkspaceLeaseSchema(latest);

    const previous = openDatabase("0008");
    expectWorkspaceLeaseSchema(previous);
  });
});

describe("WorkspaceLeaseRepository", () => {
  it("creates and reads leases only inside the requested project", () => {
    const database = openDatabase();
    seedProject(database, "project-a");
    seedProject(database, "project-b");
    const repository = new WorkspaceLeaseRepository(database, fixedClock(), ids());

    const projectA = repository.create({
      projectId: "project-a",
      executionId: "execution-shared",
      repositoryId: "main",
      workingBranch: "agent/1-first",
      baseRevisionSha: "a".repeat(40),
      workspacePath: "/tmp/workspace-a",
      expiresAt: "2026-09-08T11:00:00.000Z",
      cleanupPolicy: "retain-on-failure",
      ownerPid: 1234,
    });
    const projectB = repository.create({
      projectId: "project-b",
      executionId: "execution-shared",
      repositoryId: "main",
      workingBranch: "agent/1-first",
      baseRevisionSha: "b".repeat(40),
      workspacePath: "/tmp/workspace-b",
      expiresAt: "2026-09-08T11:00:00.000Z",
      cleanupPolicy: "delete-on-success",
    });

    expect(repository.findByExecution("project-a", "execution-shared")).toEqual(projectA);
    expect(repository.findByExecution("project-b", "execution-shared")).toEqual(projectB);
    expect(repository.findByExecution("project-a", "missing")).toBeUndefined();
    expect(repository.listActive("project-a")).toEqual([projectA]);
    expect(repository.listActive("project-b")).toEqual([projectB]);
  });

  it("lets SQLite reject an active branch or path conflict instead of overwriting", () => {
    const database = openDatabase();
    seedProject(database, "project-a");
    const repository = new WorkspaceLeaseRepository(database, fixedClock(), ids());
    const input = leaseInput("project-a", "execution-1", "main", "agent/1", "/tmp/workspace");
    repository.create(input);

    expect(() =>
      repository.create({ ...input, executionId: "execution-2", workspacePath: "/tmp/other" }),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      repository.create({ ...input, executionId: "execution-3", workingBranch: "agent/2" }),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("marks a lease retained, excludes it from active reads, and releases it idempotently", () => {
    const database = openDatabase();
    seedProject(database, "project-a");
    const clock = fixedClock();
    const repository = new WorkspaceLeaseRepository(database, clock, ids());
    const created = repository.create(
      leaseInput("project-a", "execution-1", "main", "agent/1", "/tmp/workspace"),
    );

    const retained = repository.markRetained("project-a", created.id);
    expect(retained).toMatchObject({ id: created.id, status: "retained" });
    expect(repository.listActive("project-a")).toEqual([]);
    expect(repository.markRetained("project-a", created.id)).toEqual(retained);

    clock.current = new Date("2026-09-08T10:05:00.000Z");
    const released = repository.release("project-a", created.id);
    expect(released).toMatchObject({
      id: created.id,
      status: "released",
      updatedAt: "2026-09-08T10:05:00.000Z",
    });
    expect(repository.release("project-a", created.id)).toEqual(released);
    expect(repository.listActive("project-a")).toEqual([]);

    const replacement = repository.create(
      leaseInput("project-a", "execution-2", "main", "agent/1", "/tmp/workspace"),
    );
    expect(replacement.status).toBe("active");
  });
});

function openDatabase(upToVersion?: string): Database.Database {
  const root = mkdtempSync(join(tmpdir(), "jarvis-workspace-lease-"));
  roots.push(root);
  const database = new Database(join(root, "jarvis.sqlite"));
  database.pragma("foreign_keys = ON");
  applyMigrations(database, upToVersion);
  if (upToVersion === "0008") applyMigration(database, "0009");
  databases.push(database);
  return database;
}

function expectWorkspaceLeaseSchema(database: Database.Database): void {
  const table = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_leases'")
    .get() as { sql: string } | undefined;
  expect(table?.sql).toContain("CREATE TABLE workspace_leases");
  expect(table?.sql).toContain("STRICT");

  const columns = database.prepare("PRAGMA table_info(workspace_leases)").all() as {
    name: string;
    notnull: number;
  }[];
  expect(columns.map((column) => column.name)).toEqual([
    "id",
    "project_id",
    "execution_id",
    "repository_id",
    "working_branch",
    "base_revision_sha",
    "workspace_path",
    "status",
    "expires_at",
    "cleanup_policy",
    "created_at",
    "updated_at",
    "owner_pid",
  ]);
  expect(
    columns.filter((column) => column.name !== "owner_pid").every((column) => column.notnull),
  ).toBe(true);

  const indexes = database
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workspace_leases'",
    )
    .all() as { name: string; sql: string | null }[];
  expect(indexes.map((index) => index.name)).toEqual(
    expect.arrayContaining([
      "workspace_leases_project_id_status",
      "workspace_leases_active_project_repository_branch_unique",
      "workspace_leases_active_path_unique",
    ]),
  );
  expect(
    indexes.find((index) => index.name === "workspace_leases_project_id_status")?.sql,
  ).toContain("(project_id, status)");
}

function seedProject(database: Database.Database, projectId: string): void {
  database
    .prepare(
      `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
       VALUES (@id, @name, 'active', '{}', '2026-09-08T10:00:00.000Z', '2026-09-08T10:00:00.000Z')`,
    )
    .run({ id: projectId, name: projectId });
}

function leaseInput(
  projectId: string,
  executionId: string,
  repositoryId: string,
  workingBranch: string,
  workspacePath: string,
) {
  return {
    projectId,
    executionId,
    repositoryId,
    workingBranch,
    baseRevisionSha: "a".repeat(40),
    workspacePath,
    expiresAt: "2026-09-08T11:00:00.000Z",
    cleanupPolicy: "retain-on-failure",
  };
}

function fixedClock(): { current: Date; now: () => Date } {
  return {
    current: new Date("2026-09-08T10:00:00.000Z"),
    now() {
      return this.current;
    },
  };
}

function ids(): { next: () => string } {
  let sequence = 0;
  return { next: () => `test-${++sequence}` };
}
