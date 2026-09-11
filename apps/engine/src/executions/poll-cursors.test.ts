import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredPortableProjectConfiguration } from "../../../../packages/project-runtime/src/project-types.js";
import type { ResolvedProjectSnapshot } from "../projects/store.js";
import { applyMigrations } from "../db/test-migrations.js";
import { ControllableClock } from "../events/test-doubles.js";
import { LocalAgentRuntimeRegistry } from "../projects/resource-grants.js";
import { ProjectModuleCapabilityResolver } from "./capabilities.js";
import { PollCursorStore } from "./poll-cursors.js";

const databases: Database.Database[] = [];
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openDb(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  applyMigrations(database);
  databases.push(database);
  return database;
}

describe("PollCursorStore", () => {
  it("reads missing, round-trips, replaces and isolates a cursor by project/module/repository", () => {
    const database = openDb();
    const clock = new ControllableClock(new Date("2026-09-11T08:00:00.000Z"));
    const store = new PollCursorStore(database, clock);
    insertProject(database, "project-a");
    insertProject(database, "project-b");
    const cursor = store.bind("project-a", "github-a");
    const otherModule = store.bind("project-a", "github-b");
    const otherProject = store.bind("project-b", "github-a");

    expect(cursor.read("repository-a")).toBeUndefined();

    cursor.write({
      repositoryId: "repository-a",
      externalEventId: "event-1",
      eventTimestamp: "2026-09-11T07:59:00.000Z",
    });
    expect(cursor.read("repository-a")).toEqual({
      externalEventId: "event-1",
      eventTimestamp: "2026-09-11T07:59:00.000Z",
      updatedAt: "2026-09-11T08:00:00.000Z",
    });
    expect(otherModule.read("repository-a")).toBeUndefined();
    expect(otherProject.read("repository-a")).toBeUndefined();

    clock.advance(1_000);
    cursor.write({
      repositoryId: "repository-a",
      externalEventId: "event-2",
      eventTimestamp: "2026-09-11T08:00:01.000Z",
    });
    expect(cursor.read("repository-a")).toEqual({
      externalEventId: "event-2",
      eventTimestamp: "2026-09-11T08:00:01.000Z",
      updatedAt: "2026-09-11T08:00:01.000Z",
    });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM github_cursors
           WHERE project_id = ? AND module_instance_id = ? AND repository_id = ?`,
        )
        .get("project-a", "github-a", "repository-a"),
    ).toEqual({ count: 1 });
  });

  it("rolls back a capability write with the caller transaction", () => {
    const database = openDb();
    const cursor = new PollCursorStore(
      database,
      new ControllableClock(new Date("2026-09-11T08:00:00.000Z")),
    ).bind("project-a", "github-a");
    insertProject(database, "project-a");

    expect(() =>
      database.transaction(() => {
        cursor.write({
          repositoryId: "repository-a",
          externalEventId: "event-1",
          eventTimestamp: "2026-09-11T07:59:00.000Z",
        });
        expect(cursor.read("repository-a")).toBeDefined();
        throw new Error("rollback");
      })(),
    ).toThrow("rollback");

    expect(cursor.read("repository-a")).toBeUndefined();
  });

  it("survives reopening the SQLite database", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-poll-cursor-"));
    temporaryRoots.push(root);
    const databasePath = join(root, "jarvis.sqlite");
    const clock = new ControllableClock(new Date("2026-09-11T08:00:00.000Z"));
    const first = new Database(databasePath);
    first.pragma("foreign_keys = ON");
    applyMigrations(first);
    insertProject(first, "project-a");
    new PollCursorStore(first, clock).bind("project-a", "github-a").write({
      repositoryId: "repository-a",
      externalEventId: "event-1",
      eventTimestamp: "2026-09-11T07:59:00.000Z",
    });
    first.close();

    const restarted = new Database(databasePath);
    restarted.pragma("foreign_keys = ON");
    databases.push(restarted);
    expect(
      new PollCursorStore(restarted, clock).bind("project-a", "github-a").read("repository-a"),
    ).toEqual({
      externalEventId: "event-1",
      eventTimestamp: "2026-09-11T07:59:00.000Z",
      updatedAt: "2026-09-11T08:00:00.000Z",
    });
  });

  it("cascades cursor rows when a project is deleted", () => {
    const database = openDb();
    insertProject(database, "project-a");
    insertProject(database, "project-b");
    const clock = new ControllableClock(new Date("2026-09-11T08:00:00.000Z"));
    new PollCursorStore(database, clock).bind("project-a", "github-a").write({
      repositoryId: "repository-a",
      externalEventId: "event-a",
      eventTimestamp: "2026-09-11T07:59:00.000Z",
    });
    new PollCursorStore(database, clock).bind("project-b", "github-b").write({
      repositoryId: "repository-b",
      externalEventId: "event-b",
      eventTimestamp: "2026-09-11T07:59:00.000Z",
    });

    database.prepare("DELETE FROM projects WHERE id = ?").run("project-a");

    expect(database.prepare("SELECT project_id FROM github_cursors").all()).toEqual([
      { project_id: "project-b" },
    ]);
  });

  it("exposes the cursor only for the addressed project and module instance", () => {
    const database = openDb();
    insertProject(database, "project-a");
    insertProject(database, "project-b");
    const store = new PollCursorStore(
      database,
      new ControllableClock(new Date("2026-09-11T08:00:00.000Z")),
    );
    const snapshots = new Map([
      ["project-a", projectSnapshot("project-a", ["github-a", "github-b"])],
      ["project-b", projectSnapshot("project-b", ["github-a"])],
    ]);
    const resolver = new ProjectModuleCapabilityResolver(
      { getResolvedProject: (projectId) => snapshots.get(projectId) },
      { composition: () => ({ requires: [] }) },
      new LocalAgentRuntimeRegistry(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );

    const projectAModuleA = resolver.resolve("project-a", "github-a", "github-module").pollCursor;
    const projectAModuleB = resolver.resolve("project-a", "github-b", "github-module").pollCursor;
    const projectBModuleA = resolver.resolve("project-b", "github-a", "github-module").pollCursor;
    projectAModuleA?.write({
      repositoryId: "repository-a",
      externalEventId: "event-1",
      eventTimestamp: "2026-09-11T07:59:00.000Z",
    });

    expect(projectAModuleA?.read("repository-a")).toBeDefined();
    expect(projectAModuleB?.read("repository-a")).toBeUndefined();
    expect(projectBModuleA?.read("repository-a")).toBeUndefined();
  });
});

function insertProject(database: Database.Database, id: string): void {
  database
    .prepare(
      `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
       VALUES (?, ?, 'active', '{}', ?, ?)`,
    )
    .run(id, id, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
}

function projectSnapshot(
  projectId: string,
  moduleInstanceIds: readonly string[],
): ResolvedProjectSnapshot {
  const composition: StoredPortableProjectConfiguration = {
    apiVersion: "jarvis.dev/project/v1",
    kind: "Project",
    metadata: { id: projectId, name: projectId },
    repositories: [{ id: "main", root: ".", defaultBranch: "main", remote: "origin" }],
    slots: {},
    commands: {},
    git: {
      branchPattern: "agent/{workItemId}-{slug}",
      commitStrategy: "conventional",
      pushRemote: "origin",
      allowForcePush: false,
    },
    workspace: { strategy: "git-worktree", maxConcurrentExecutions: 1, retainOnFailureDays: 7 },
    modules: [],
  };
  return {
    composition,
    moduleInstances: moduleInstanceIds.map((instanceId) => ({
      instanceId,
      moduleId: "github-module",
      enabled: true,
    })),
    bindings: { slots: {}, repository: { path: `/tmp/${projectId}`, bookmarkRef: null } },
    requestRoutes: [],
  };
}
