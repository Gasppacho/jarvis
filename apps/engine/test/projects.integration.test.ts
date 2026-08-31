import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { explain, localApiValidator } from "./contract.js";
import { startEngine, type Harness } from "./harness.js";
import { makeNodeRepositoryFixture, makeRepositoryFixture } from "./repository-fixture.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Snapshot of every file's size and mtime, to prove discovery mutates nothing. */
function treeSnapshot(root: string): string {
  const files = execFileSync("find", [root, "-type", "f"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .sort();
  return files
    .map((file) => {
      const stats = statSync(file);
      return `${file}:${stats.size}:${stats.mtimeMs}`;
    })
    .join("\n");
}

describe("repository discovery and project import", () => {
  it("bundles the schema needed to validate a committed project config", () => {
    expect(
      existsSync(join(REPO_ROOT, "dist/engine/contracts/schemas/project-config.v1.schema.json")),
    ).toBe(true);
  });

  const started: Harness[] = [];
  const roots: string[] = [];
  let validateDiscovery: ReturnType<typeof localApiValidator>;
  let validateSummary: ReturnType<typeof localApiValidator>;
  let validateDetail: ReturnType<typeof localApiValidator>;

  beforeAll(() => {
    validateDiscovery = localApiValidator("RepositoryDiscovery");
    validateSummary = localApiValidator("ProjectSummary");
    validateDetail = localApiValidator("ProjectDetail");
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((engine) => engine.dispose()));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function start(...args: Parameters<typeof startEngine>) {
    const engine = await startEngine(...args);
    started.push(engine);
    return engine;
  }

  function fixture(factory: () => string): string {
    const root = factory();
    roots.push(root);
    return root;
  }

  const discover = (engine: Harness, path: string) =>
    engine.call("/v1/discovery/repository", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });

  const importProject = (engine: Harness, body: Record<string, unknown>) =>
    engine.call("/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("detects git, remote, provider, branch, package manager and scripts", async () => {
    const engine = await start();
    const root = fixture(() => makeNodeRepositoryFixture({ branch: "trunk" }));

    const response = await discover(engine, root);
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(validateDiscovery(body), explain(validateDiscovery)).toBe(true);
    expect(body).toMatchObject({
      isGitRepository: true,
      remoteUrl: "git@github.com:QServices/token-warehouse.git",
      provider: "github",
      defaultBranch: "trunk",
      packageManager: "pnpm",
    });
    expect(body["scripts"]).toMatchObject({
      test: "vitest run",
      lint: "eslint .",
    });
  });

  it("reports a plain directory as not a git repository", async () => {
    const engine = await start();
    const root = fixture(() => makeRepositoryFixture({}));
    rmSync(join(root, ".git"), { recursive: true, force: true });

    const body = (await (await discover(engine, root)).json()) as Record<string, unknown>;
    expect(validateDiscovery(body)).toBe(true);
    expect(body["isGitRepository"]).toBe(false);
  });

  it("never modifies the inspected repository", async () => {
    const engine = await start();
    const root = fixture(() => makeNodeRepositoryFixture());

    const before = treeSnapshot(root);
    await discover(engine, root);
    await importProject(engine, { repositoryPath: root });
    expect(treeSnapshot(root)).toBe(before);
  });

  it("refuses a path that is missing, relative or not a directory", async () => {
    const engine = await start();

    for (const path of ["relative/path", "/definitely/not/here", ""]) {
      const response = await discover(engine, path);
      expect(response.status, `path "${path}"`).toBeGreaterThanOrEqual(400);
      const body = (await response.json()) as { error?: { code: string } };
      expect(body.error?.code).toMatch(/^repository\./);
    }
  });

  it("imports a draft project and keeps the absolute path out of the portable config", async () => {
    const engine = await start();
    const root = fixture(() => makeNodeRepositoryFixture());

    const response = await importProject(engine, { repositoryPath: root });
    expect(response.status).toBe(201);

    const detail = (await response.json()) as Record<string, unknown>;
    expect(validateDetail(detail), explain(validateDetail)).toBe(true);
    expect(detail).toMatchObject({ status: "draft" });

    // The portable config is committed to the user's repository: it must never
    // carry a machine-specific path (docs/architecture/PROJECTS.md).
    expect(JSON.stringify(detail["portableConfig"])).not.toContain(root);
    expect(JSON.stringify(detail["portableConfig"])).not.toMatch(/(^|")\//);
    expect(JSON.stringify(detail["bindingStatus"])).toContain(root);
  });

  it("refuses to import the same repository twice", async () => {
    const engine = await start();
    const root = fixture(() => makeNodeRepositoryFixture());

    expect((await importProject(engine, { repositoryPath: root })).status).toBe(201);

    const second = await importProject(engine, { repositoryPath: root });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
      "project.already-imported",
    );
  });

  it("rejects a supplied portable config that breaks the schema", async () => {
    const engine = await start();
    const root = fixture(() => makeNodeRepositoryFixture());

    const response = await importProject(engine, {
      repositoryPath: root,
      portableConfig: { apiVersion: "jarvis.dev/project/v1", kind: "Project" },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("project.config-invalid");
  });

  it("adopts an existing .jarvis/project.yaml", async () => {
    const engine = await start();
    const committed = readFileSync(
      join(REPO_ROOT, "examples/project/.jarvis/project.yaml"),
      "utf8",
    );
    const root = fixture(() => makeNodeRepositoryFixture({ projectYaml: committed }));

    const detail = (await (await importProject(engine, { repositoryPath: root })).json()) as {
      id: string;
      name: string;
      moduleCount: number;
    };
    expect(detail.id).toBe("token-warehouse");
    expect(detail.name).toBe("Token Warehouse");
    expect(detail.moduleCount).toBe(3);
  });

  it("lists imported projects and serves their detail", async () => {
    const engine = await start();
    const root = fixture(() => makeNodeRepositoryFixture());
    const created = (await (await importProject(engine, { repositoryPath: root })).json()) as {
      id: string;
    };

    const list = (await (await engine.call("/v1/projects")).json()) as {
      items: Record<string, unknown>[];
    };
    expect(list.items).toHaveLength(1);
    expect(validateSummary(list.items[0]), explain(validateSummary)).toBe(true);
    expect(list.items[0]).toMatchObject({ id: created.id, status: "draft" });

    const detail = await engine.call(`/v1/projects/${created.id}`);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { id: string }).id).toBe(created.id);
  });

  it("returns a 404 envelope for an unknown project", async () => {
    const engine = await start();

    const response = await engine.call("/v1/projects/does-not-exist");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "project.not-found",
    );
  });

  it("understands a linked worktree, whose .git is a file", async () => {
    const engine = await start();
    const main = fixture(() => makeNodeRepositoryFixture());

    // A linked worktree: .git is a file pointing at the real git directory.
    const worktree = fixture(() => makeRepositoryFixture({}));
    rmSync(join(worktree, ".git"), { recursive: true, force: true });
    const gitDir = join(main, ".git", "worktrees", "feature");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/feature\n", "utf8");
    writeFileSync(join(gitDir, "commondir"), "../..\n", "utf8");
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`, "utf8");

    const body = (await (await discover(engine, worktree)).json()) as Record<string, unknown>;
    expect(validateDiscovery(body), explain(validateDiscovery)).toBe(true);
    expect(body).toMatchObject({
      isGitRepository: true,
      defaultBranch: "feature",
      // Remotes live in the shared commondir, not in the worktree's git dir.
      remoteUrl: "git@github.com:QServices/token-warehouse.git",
      provider: "github",
    });
  });

  it("understands a linked worktree whose git directory contains spaces", async () => {
    const engine = await start();
    const main = fixture(() => makeNodeRepositoryFixture());

    const worktree = fixture(() => makeRepositoryFixture({}));
    rmSync(join(worktree, ".git"), { recursive: true, force: true });
    const gitDir = join(main, ".git", "worktrees", "feature with spaces");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/spaced-feature\n", "utf8");
    writeFileSync(join(gitDir, "commondir"), "../..\n", "utf8");
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`, "utf8");

    const response = await discover(engine, worktree);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      isGitRepository: true,
      defaultBranch: "spaced-feature",
      remoteUrl: "git@github.com:QServices/token-warehouse.git",
    });
  });

  it("reads a submodule's own remote and branch through its gitdir file", async () => {
    const engine = await start();
    const parent = fixture(() => makeNodeRepositoryFixture());

    const submodule = fixture(() => makeRepositoryFixture({}));
    rmSync(join(submodule, ".git"), { recursive: true, force: true });
    const gitDir = join(parent, ".git", "modules", "nested", "dependency");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/release\n", "utf8");
    writeFileSync(
      join(gitDir, "config"),
      ['[remote "origin"]', "\turl = https://gitlab.com/team/dependency.git", ""].join("\n"),
      "utf8",
    );
    writeFileSync(join(submodule, ".git"), `gitdir: ${gitDir}\n`, "utf8");

    const response = await discover(engine, submodule);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      isGitRepository: true,
      defaultBranch: "release",
      remoteUrl: "https://gitlab.com/team/dependency.git",
      provider: "gitlab",
    });
  });

  it("recognises the same repository reached through a symlink", async () => {
    const engine = await start();
    const real = fixture(() => makeNodeRepositoryFixture());
    const link = join(mkdtempSync(join(tmpdir(), "jarvis-link-")), "alias");
    roots.push(dirname(link));
    symlinkSync(real, link, "dir");

    expect((await importProject(engine, { repositoryPath: real })).status).toBe(201);

    const viaSymlink = await importProject(engine, { repositoryPath: link });
    expect(viaSymlink.status).toBe(409);
    expect(((await viaSymlink.json()) as { error: { code: string } }).error.code).toBe(
      "project.already-imported",
    );
  });

  it("refuses an oversized committed configuration instead of ignoring it", async () => {
    const engine = await start();
    const root = fixture(() => makeNodeRepositoryFixture());
    mkdirSync(join(root, ".jarvis"), { recursive: true });
    writeFileSync(join(root, ".jarvis", "project.yaml"), "#".repeat(600 * 1024), "utf8");

    const response = await importProject(engine, { repositoryPath: root });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "project.config-invalid",
    );
  });

  it("refuses an unreadable committed configuration instead of replacing it", async () => {
    const engine = await start();
    const root = fixture(() => makeNodeRepositoryFixture());
    const directory = join(root, ".jarvis");
    const file = join(directory, "project.yaml");
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, "apiVersion: jarvis.dev/project/v1\n", "utf8");
    chmodSync(file, 0o000);

    try {
      const response = await importProject(engine, { repositoryPath: root });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "project.config-invalid",
      );
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it("keeps imported projects across an engine restart", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "jarvis-projects-"));
    const root = fixture(() => makeNodeRepositoryFixture());
    try {
      const first = await start({ dataRoot });
      const created = (await (await importProject(first, { repositoryPath: root })).json()) as {
        id: string;
      };
      await first.dispose();

      const second = await start({ dataRoot });
      started.push(second);
      const list = (await (await second.call("/v1/projects")).json()) as {
        items: { id: string }[];
      };
      expect(list.items.map((item) => item.id)).toEqual([created.id]);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
