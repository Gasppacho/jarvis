import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { Clock } from "../../../../packages/kernel/src/clock.js";
import type { StoredPortableProjectConfiguration } from "../../../../packages/project-runtime/src/project-types.js";
import { ProjectStore } from "./store.js";

const clock: Clock = { now: () => new Date("2026-01-02T03:04:05.000Z") };
let db: Database.Database | undefined;

afterEach(() => db?.close());

describe("ProjectStore transactions", () => {
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
});

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
