import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine, type Harness } from "./harness.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const roots: string[] = [];
const engines: Harness[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureAt0002(valid = true): { dataRoot: string; databasePath: string } {
  const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-migration-0002-"));
  roots.push(dataRoot);
  const databasePath = join(dataRoot, "jarvis.sqlite");
  const db = new Database(databasePath);
  db.exec(
    `CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT`,
  );
  db.exec(readFileSync(join(REPO_ROOT, "apps/engine/src/db/migrations/0001_init.sql"), "utf8"));
  if (valid) {
    db.exec(
      readFileSync(join(REPO_ROOT, "apps/engine/src/db/migrations/0002_projects.sql"), "utf8"),
    );
    db.prepare(
      `INSERT INTO projects (id, name, status, portable_config, created_at, updated_at)
       VALUES (?, ?, 'draft', ?, datetime('now'), datetime('now'))`,
    ).run(
      "imported-project",
      "Imported Project",
      JSON.stringify({
        apiVersion: "jarvis.dev/project/v1",
        kind: "Project",
        metadata: { id: "imported-project", name: "Imported Project" },
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
      }),
    );
    db.prepare(
      `INSERT INTO project_bindings (project_id, repository_path, bookmark_ref)
       VALUES (?, ?, ?)`,
    ).run("imported-project", dataRoot, "bookmark/imported-project/main");
  }
  db.prepare(
    `INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime('now')), (?, datetime('now'))`,
  ).run("0001_init", "0002_projects");
  db.close();
  return { dataRoot, databasePath };
}

describe("project Local Bindings migration 0003", () => {
  it("applies once, preserves imports and initializes unresolved slots", async () => {
    const fixture = fixtureAt0002();
    const first = await startEngine({ dataRoot: fixture.dataRoot });
    engines.push(first);
    const bindings = await first.call("/v1/projects/imported-project/bindings");
    expect(bindings.status).toBe(200);
    expect(await bindings.json()).toEqual({
      apiVersion: "jarvis.dev/project-bindings/v1",
      kind: "ProjectBindings",
      projectId: "imported-project",
      repositories: {
        main: {
          path: fixture.dataRoot,
          bookmarkRef: "bookmark/imported-project/main",
        },
      },
      slots: {},
    });
    await first.dispose();

    const second = await startEngine({ dataRoot: fixture.dataRoot });
    engines.push(second);
    await second.dispose();

    const db = new Database(fixture.databasePath, { readonly: true });
    const versions = db
      .prepare(
        "SELECT version FROM schema_migrations WHERE version = '0003_project_local_bindings'",
      )
      .all();
    const row = db
      .prepare("SELECT bookmark_ref, slot_bindings FROM project_bindings WHERE project_id = ?")
      .get("imported-project") as { bookmark_ref: string; slot_bindings: string };
    db.close();
    expect(versions).toHaveLength(1);
    expect(row).toEqual({
      bookmark_ref: "bookmark/imported-project/main",
      slot_bindings: "{}",
    });
  });

  it("rolls back the schema and version record when the 0002 fixture is invalid", async () => {
    const fixture = fixtureAt0002(false);
    const engine = await startEngine({ dataRoot: fixture.dataRoot });
    engines.push(engine);
    expect(await (await engine.call("/v1/health")).json()).toMatchObject({
      status: "degraded",
      database: "failed",
    });
    await engine.dispose();

    const db = new Database(fixture.databasePath, { readonly: true });
    const version = db
      .prepare("SELECT 1 FROM schema_migrations WHERE version = '0003_project_local_bindings'")
      .get();
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_bindings'")
      .get();
    db.close();
    expect(version).toBeUndefined();
    expect(table).toBeUndefined();
  });
});
