import Database from "better-sqlite3";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { explain, localApiValidator } from "./contract.js";
import { startEngine, type Harness } from "./harness.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const roots: string[] = [];
const engines: Harness[] = [];
const NORMALIZATION_MIGRATION = "0004_normalize_project_drafts";

function backupPaths(databasePath: string): string[] {
  const prefix = `${basename(databasePath)}.pre-${NORMALIZATION_MIGRATION}-`;
  return readdirSync(dirname(databasePath))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
    .sort()
    .map((name) => join(dirname(databasePath), name));
}

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
        repositories: [{ id: "main", root: ".", defaultBranch: "main", remote: "origin" }],
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

function fixtureAt0003WithLegacyDraft(): { dataRoot: string; databasePath: string } {
  const fixture = fixtureAt0002();
  const db = new Database(fixture.databasePath);
  db.exec(
    readFileSync(
      join(REPO_ROOT, "apps/engine/src/db/migrations/0003_project_local_bindings.sql"),
      "utf8",
    ),
  );
  db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime('now'))`).run(
    "0003_project_local_bindings",
  );
  db.close();
  return fixture;
}

function completeExistingComposition(databasePath: string): string {
  const db = new Database(databasePath);
  const row = db
    .prepare("SELECT portable_config FROM projects WHERE id = ?")
    .get("imported-project") as { portable_config: string };
  const configuration = JSON.parse(row.portable_config) as Record<string, unknown>;
  configuration["slots"] = {
    sourceControl: {
      requires: "scm.change-request.manage",
      optional: true,
      description: "Preserve this exact slot",
    },
  };
  configuration["modules"] = [
    {
      instanceId: "github",
      moduleId: "jarvis.module.github",
      enabled: false,
      configuration: { pollIntervalSeconds: 30, repositories: ["owner/repo"] },
    },
  ];
  const stored = JSON.stringify(configuration);
  db.prepare("UPDATE projects SET portable_config = ? WHERE id = ?").run(
    stored,
    "imported-project",
  );
  db.close();
  return stored;
}

describe("project composition migrations", () => {
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

  it("upgrades a persisted pre-composition draft into the decodable draft contract", async () => {
    const fixture = fixtureAt0003WithLegacyDraft();
    const engine = await startEngine({ dataRoot: fixture.dataRoot });
    engines.push(engine);

    const response = await engine.call("/v1/projects/imported-project");
    expect(response.status).toBe(200);
    const detail = (await response.json()) as Record<string, unknown>;
    const validateDetail = localApiValidator("ProjectDetail");
    expect(validateDetail(detail), explain(validateDetail)).toBe(true);
    expect(detail["portableConfig"]).toMatchObject({
      metadata: { id: "imported-project", name: "Imported Project" },
      slots: {},
      modules: [],
    });

    await engine.dispose();
    const restarted = await startEngine({ dataRoot: fixture.dataRoot });
    engines.push(restarted);
    const afterRestart = (await (await restarted.call("/v1/projects/imported-project")).json()) as {
      portableConfig: unknown;
    };
    expect(afterRestart.portableConfig).toEqual(detail["portableConfig"]);

    const db = new Database(fixture.databasePath, { readonly: true });
    const normalized = db
      .prepare("SELECT 1 FROM schema_migrations WHERE version = '0004_normalize_project_drafts'")
      .get();
    db.close();
    expect(normalized).toBeDefined();

    const [snapshot] = backupPaths(fixture.databasePath);
    expect(snapshot).toBeDefined();
    expect(statSync(snapshot!).mode & 0o777).toBe(0o600);
    const backup = new Database(snapshot!, { readonly: true });
    const before = backup
      .prepare("SELECT portable_config FROM projects WHERE id = ?")
      .get("imported-project") as { portable_config: string };
    backup.close();
    expect(JSON.parse(before.portable_config)).not.toHaveProperty("slots");
  });

  it("preserves an existing composition byte-for-byte when normalization is reapplied", async () => {
    const fixture = fixtureAt0003WithLegacyDraft();
    const before = completeExistingComposition(fixture.databasePath);
    const engine = await startEngine({ dataRoot: fixture.dataRoot });
    engines.push(engine);
    await engine.dispose();

    const db = new Database(fixture.databasePath);
    db.exec(
      readFileSync(
        join(REPO_ROOT, "apps/engine/src/db/migrations/0004_normalize_project_drafts.sql"),
        "utf8",
      ),
    );
    const after = db
      .prepare("SELECT portable_config FROM projects WHERE id = ?")
      .get("imported-project") as { portable_config: string };
    db.close();
    expect(after.portable_config).toBe(before);
  });

  it("keeps the first valid snapshot across a failed migration retry", async () => {
    const fixture = fixtureAt0003WithLegacyDraft();
    const db = new Database(fixture.databasePath);
    db.exec(
      `CREATE TRIGGER reject_project_normalization
       BEFORE UPDATE ON projects
       BEGIN SELECT RAISE(FAIL, 'simulated migration failure'); END`,
    );
    db.close();

    const failed = await startEngine({ dataRoot: fixture.dataRoot });
    engines.push(failed);
    expect(await (await failed.call("/v1/health")).json()).toMatchObject({
      status: "degraded",
      database: "failed",
    });
    await failed.dispose();

    const [firstSnapshot] = backupPaths(fixture.databasePath);
    expect(firstSnapshot).toBeDefined();
    const beforeRetry = readFileSync(firstSnapshot!);
    const repair = new Database(fixture.databasePath);
    repair.exec("DROP TRIGGER reject_project_normalization");
    repair.close();

    const retried = await startEngine({ dataRoot: fixture.dataRoot });
    engines.push(retried);
    expect((await retried.call("/v1/projects/imported-project")).status).toBe(200);
    expect(readFileSync(firstSnapshot!)).toEqual(beforeRetry);
    expect(backupPaths(fixture.databasePath)).toHaveLength(2);
  });

  it("cannot be suppressed by a planted backup-like symbolic link", async () => {
    const fixture = fixtureAt0003WithLegacyDraft();
    const planted = join(fixture.dataRoot, "planted-backup");
    const predictable = `${fixture.databasePath}.pre-${NORMALIZATION_MIGRATION}.bak`;
    writeFileSync(planted, "not a database", "utf8");
    symlinkSync(planted, predictable);

    const engine = await startEngine({ dataRoot: fixture.dataRoot });
    engines.push(engine);
    expect((await engine.call("/v1/projects/imported-project")).status).toBe(200);
    expect(backupPaths(fixture.databasePath)).toHaveLength(1);
  });

  it("does not create a migration backup for a fresh database", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-fresh-migration-"));
    roots.push(dataRoot);
    const engine = await startEngine({ dataRoot });
    engines.push(engine);
    expect(await (await engine.call("/v1/health")).json()).toMatchObject({
      status: "ready",
      database: "ready",
    });
    expect(backupPaths(join(dataRoot, "jarvis.sqlite"))).toEqual([]);
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
