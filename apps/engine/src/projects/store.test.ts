import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { Clock } from "../../../../packages/kernel/src/clock.js";
import type { ProjectRepositoryIdentity } from "../../../../packages/module-sdk/src/index.js";
import type { StoredPortableProjectConfiguration } from "../../../../packages/project-runtime/src/project-types.js";
import type { ResolvedProjectSnapshot } from "./store.js";
import { ProjectStore } from "./store.js";

const clock: Clock = { now: () => new Date("2026-01-02T03:04:05.000Z") };
let db: Database.Database | undefined;

afterEach(() => db?.close());

describe("ProjectStore transactions", () => {
  it("exposes primitive deletion and leaves the transaction invariant to its caller", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
        portable_config TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE project_bindings (
        project_id TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
        repository_path TEXT NOT NULL, bookmark_ref TEXT, slot_bindings TEXT NOT NULL DEFAULT '{}'
      ) STRICT;
    `);
    const store = new ProjectStore(db, clock);
    store.createProject({
      id: "project",
      name: "Project",
      status: "active",
      portableConfig: draft("Project"),
      repositoryPath: "/tmp/project",
    });

    expect(store.findById("project")?.status).toBe("active");
    expect(store.deleteById("project")).toBe(true);
    expect(store.findById("project")).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM project_bindings").get()).toBeUndefined();
    expect(store.deleteById("unknown")).toBe(false);
  });

  it("rolls back earlier SQLite writes when a later operation fails", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
        portable_config TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE project_bindings (
        project_id TEXT PRIMARY KEY REFERENCES projects (id), repository_path TEXT NOT NULL,
        bookmark_ref TEXT, slot_bindings TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(slot_bindings))
      ) STRICT;
    `);
    const store = new ProjectStore(db, clock);
    const original = draft("Original");
    store.createProject({
      id: "project",
      name: "Original",
      status: "draft",
      portableConfig: original,
      repositoryPath: "/tmp/project",
    });

    expect(() =>
      store.transaction(() => {
        store.replaceConfiguration("project", draft("Replacement"), "Replacement");
        store.replaceBindings("project", "/tmp/project", null, {
          sourceControl: { kind: "connection", ref: "granted" },
        });
        throw new Error("failpoint after both updates");
      }),
    ).toThrow("failpoint");

    expect(store.findById("project")).toMatchObject({
      name: "Original",
      portableConfig: original,
      slotBindings: {},
    });
  });

  it("refreshes a changed repository identity in place for the same fingerprint", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
        portable_config TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE project_bindings (
        project_id TEXT PRIMARY KEY REFERENCES projects (id), repository_path TEXT NOT NULL,
        bookmark_ref TEXT, slot_bindings TEXT NOT NULL DEFAULT '{}'
      ) STRICT;
      CREATE TABLE project_resolved_compositions (
        project_id TEXT PRIMARY KEY REFERENCES projects (id),
        composition_fingerprint TEXT NOT NULL,
        resolved_project TEXT NOT NULL,
        activated_at TEXT NOT NULL
      ) STRICT;
    `);
    const store = new ProjectStore(db, clock);
    store.createProject({
      id: "project",
      name: "Project",
      status: "draft",
      portableConfig: draft("Project"),
      repositoryPath: "/tmp/project",
    });

    store.activateProject("project", "fingerprint", snapshot("Gasppacho", "jarvis"));
    store.activateProject("project", "fingerprint", snapshot("Other", "repo"));

    expect(
      db.prepare("SELECT COUNT(*) AS count FROM project_resolved_compositions").get() as {
        count: number;
      },
    ).toEqual({ count: 1 });
    expect(store.getResolvedProject("project")?.repositoryIdentities).toEqual([
      { repositoryId: "main", provider: "github", owner: "Other", name: "repo" },
    ]);
  });
});

function snapshot(owner: string, name: string): ResolvedProjectSnapshot {
  const identity: ProjectRepositoryIdentity = {
    repositoryId: "main",
    provider: "github",
    owner,
    name,
  };
  return {
    composition: draft("Project"),
    moduleInstances: [],
    bindings: { slots: {}, repository: { path: "/tmp/project", bookmarkRef: null } },
    requestRoutes: [],
    repositoryIdentities: [identity],
  };
}

function draft(name: string): StoredPortableProjectConfiguration {
  return {
    apiVersion: "jarvis.dev/project/v1",
    kind: "Project",
    metadata: { id: "project", name },
    repositories: [{ id: "main", root: "." }],
    commands: {},
    git: {
      branchPattern: "agent/{workItemId}-{slug}",
      commitStrategy: "conventional",
      pushRemote: "origin",
      allowForcePush: false,
    },
    workspace: {
      strategy: "git-worktree",
      maxConcurrentExecutions: 1,
      retainOnFailureDays: 7,
    },
    slots: {},
    modules: [],
  };
}
