import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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
import { parse as parseYaml } from "yaml";
import { explain, localApiValidator } from "./contract.js";
import { startEngine, type Harness } from "./harness.js";
import { makeNodeRepositoryFixture, makeRepositoryFixture } from "./repository-fixture.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Snapshot of every file's size and mtime, to prove discovery mutates nothing. */
function setNestedConfigurationValue(config: Record<string, unknown>, value: string): void {
  const modules = config["modules"] as Record<string, unknown>[];
  const configuration = modules[1]!["configuration"] as Record<string, unknown>;
  const rules = configuration["rules"] as Record<string, unknown>[];
  const emit = rules[0]!["emit"] as Record<string, unknown>;
  emit["payload"] = { nested: { value } };
}

function setNestedSecretLiteral(config: Record<string, unknown>, key: string): void {
  const modules = config["modules"] as Record<string, unknown>[];
  const configuration = modules[1]!["configuration"] as Record<string, unknown>;
  const rules = configuration["rules"] as Record<string, unknown>[];
  const emit = rules[0]!["emit"] as Record<string, unknown>;
  emit["payload"] = { nested: { [key]: "must-not-appear" } };
}

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
  it("bundles the schemas needed to validate project configuration and Local Bindings", () => {
    for (const schema of ["project-config.v1.schema.json", "project-bindings.v1.schema.json"]) {
      expect(existsSync(join(REPO_ROOT, "dist/engine/contracts/schemas", schema))).toBe(true);
    }
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
    expect(detail).toMatchObject({
      status: "draft",
      portableConfig: {
        repositories: [{ id: "main", root: "." }],
        slots: {},
        modules: [],
        git: expect.any(Object),
        workspace: expect.any(Object),
      },
    });
    const validateDraft = localApiValidator("PortableProjectDraft");
    expect(validateDraft(detail["portableConfig"]), explain(validateDraft)).toBe(true);

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

  it("restores a draft and reports its missing repository after an engine restart", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "jarvis-projects-"));
    const root = fixture(() => makeNodeRepositoryFixture());
    try {
      const first = await start({ dataRoot });
      const created = (await (await importProject(first, { repositoryPath: root })).json()) as {
        id: string;
        status: string;
        portableConfig: unknown;
        bindingStatus: Record<string, { path: string; accessible: boolean }>;
      };
      await first.dispose();
      rmSync(root, { recursive: true, force: true });

      const second = await start({ dataRoot });
      started.push(second);
      const list = (await (await second.call("/v1/projects")).json()) as {
        items: { id: string; status: string }[];
      };
      expect(list.items).toEqual([expect.objectContaining({ id: created.id, status: "draft" })]);

      const detail = (await (await second.call(`/v1/projects/${created.id}`)).json()) as {
        portableConfig: unknown;
        bindingStatus: Record<string, { path: string; accessible: boolean }>;
      };
      expect(detail.portableConfig).toEqual(created.portableConfig);
      expect(detail.bindingStatus["main"]).toEqual({
        path: created.bindingStatus["main"]?.path,
        accessible: false,
        bookmarkRef: null,
      });
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("replaces and persists validated module configuration without writing the repository", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "jarvis-project-config-"));
    const root = fixture(() => makeNodeRepositoryFixture());
    const portableConfig = parseYaml(
      readFileSync(join(REPO_ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
    ) as Record<string, unknown>;
    try {
      const first = await start({ dataRoot });
      const created = (await (await importProject(first, { repositoryPath: root })).json()) as {
        id: string;
      };
      const projectFile = join(root, ".jarvis", "project.yaml");

      const replaced = await first.call(`/v1/projects/${created.id}/configuration`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ portableConfig, writeToRepository: false }),
      });
      expect(replaced.status).toBe(200);
      expect(existsSync(projectFile)).toBe(false);
      expect(await replaced.json()).toMatchObject({
        name: "Token Warehouse",
        status: "draft",
        moduleCount: 3,
        portableConfig,
      });
      const localBindings = (await (
        await first.call(`/v1/projects/${created.id}/bindings`)
      ).json()) as Record<string, unknown>;
      const persistedBindings = {
        ...localBindings,
        slots: {
          sourceControl: { kind: "module-instance", ref: "github" },
        },
      };
      expect(
        (
          await first.call(`/v1/projects/${created.id}/bindings`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(persistedBindings),
          })
        ).status,
      ).toBe(200);
      await first.dispose();

      const second = await start({ dataRoot });
      started.push(second);
      expect(await (await second.call(`/v1/projects/${created.id}`)).json()).toMatchObject({
        portableConfig,
        moduleCount: 3,
      });
      expect(await (await second.call(`/v1/projects/${created.id}/bindings`)).json()).toEqual(
        persistedBindings,
      );
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "duplicate instance id",
      (config: Record<string, unknown>) => {
        const modules = config["modules"] as Record<string, unknown>[];
        modules[1]!["instanceId"] = modules[0]!["instanceId"];
      },
    ],
    [
      "repository root other than the MVP root",
      (config: Record<string, unknown>) => {
        const repositories = config["repositories"] as Record<string, unknown>[];
        repositories[0]!["root"] = "packages/app";
      },
    ],
    [
      "unknown bundled package",
      (config: Record<string, unknown>) => {
        const modules = config["modules"] as Record<string, unknown>[];
        modules[0]!["moduleId"] = "jarvis.module.unknown";
      },
    ],
    [
      "missing required package configuration",
      (config: Record<string, unknown>) => {
        const modules = config["modules"] as Record<string, unknown>[];
        delete modules[0]!["configuration"];
      },
    ],
    [
      "invalid package configuration",
      (config: Record<string, unknown>) => {
        const modules = config["modules"] as Record<string, unknown>[];
        (modules[2]!["configuration"] as Record<string, unknown>)["maxRepairCycles"] = "invalid";
      },
    ],
    [
      "unknown project slot",
      (config: Record<string, unknown>) => {
        const modules = config["modules"] as Record<string, unknown>[];
        modules[2]!["runtimeSlot"] = "missingRuntime";
      },
    ],
    [
      "unknown project repository",
      (config: Record<string, unknown>) => {
        const modules = config["modules"] as Record<string, unknown>[];
        const bindings = modules[2]!["bindings"] as Record<string, unknown>;
        bindings["repository"] = "missingRepository";
      },
    ],
    [
      "nested POSIX absolute path",
      (config: Record<string, unknown>) =>
        setNestedConfigurationValue(config, "/Users/alice/private"),
    ],
    [
      "nested POSIX path with an uncommon machine root",
      (config: Record<string, unknown>) => setNestedConfigurationValue(config, "/mnt/data"),
    ],
    [
      "nested home-relative path",
      (config: Record<string, unknown>) => setNestedConfigurationValue(config, "~/private"),
    ],
    [
      "nested named-user home path",
      (config: Record<string, unknown>) => setNestedConfigurationValue(config, "~alice/private"),
    ],
    [
      "nested Windows absolute path",
      (config: Record<string, unknown>) =>
        setNestedConfigurationValue(config, "C:\\Users\\alice\\private"),
    ],
    [
      "whitespace-padded command absolute path",
      (config: Record<string, unknown>) => {
        (config["commands"] as Record<string, unknown>)["test"] = "  /usr/local/bin/test  ";
      },
    ],
    [
      "file URL in metadata",
      (config: Record<string, unknown>) => {
        (config["metadata"] as Record<string, unknown>)["description"] =
          "  file:///Users/alice/private  ";
      },
    ],
    [
      "single-slash file URL in metadata",
      (config: Record<string, unknown>) => {
        (config["metadata"] as Record<string, unknown>)["description"] =
          "  file:/Users/alice/private  ";
      },
    ],
    [
      "Windows UNC path in slot metadata",
      (config: Record<string, unknown>) => {
        const slots = config["slots"] as Record<string, Record<string, unknown>>;
        slots["sourceControl"]!["description"] = "  \\\\server\\private  ";
      },
    ],
    [
      "nested secret literal",
      (config: Record<string, unknown>) => setNestedSecretLiteral(config, "secret"),
    ],
    [
      "nested token literal",
      (config: Record<string, unknown>) => setNestedSecretLiteral(config, "token"),
    ],
    [
      "nested password literal with padded key",
      (config: Record<string, unknown>) => setNestedSecretLiteral(config, " password "),
    ],
    [
      "nested API-key literal",
      (config: Record<string, unknown>) => setNestedSecretLiteral(config, "api-key"),
    ],
    [
      "nested machine identifier",
      (config: Record<string, unknown>) => setNestedSecretLiteral(config, "hostName"),
    ],
  ])("rejects %s without replacing the last durable configuration", async (_case, mutate) => {
    const engine = await start();
    const root = fixture(() => makeNodeRepositoryFixture());
    const created = (await (await importProject(engine, { repositoryPath: root })).json()) as {
      id: string;
      portableConfig: unknown;
    };
    const portableConfig = parseYaml(
      readFileSync(join(REPO_ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
    ) as Record<string, unknown>;
    mutate(portableConfig);

    const response = await engine.call(`/v1/projects/${created.id}/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portableConfig, writeToRepository: false }),
    });
    expect(response.status).toBe(400);
    const error = (await response.json()) as { error: { code: string; message: string } };
    expect(error.error.code).toBe("project.config-invalid");
    expect(error.error.message).not.toContain("must-not-appear");
    expect(await (await engine.call(`/v1/projects/${created.id}`)).json()).toMatchObject({
      portableConfig: created.portableConfig,
    });
  });

  it("preserves valid remote URLs and relative commands during portable validation", async () => {
    const engine = await start();
    const root = fixture(() => makeNodeRepositoryFixture());
    const created = (await (await importProject(engine, { repositoryPath: root })).json()) as {
      id: string;
    };
    const portableConfig = parseYaml(
      readFileSync(join(REPO_ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
    ) as Record<string, unknown>;
    (portableConfig["repositories"] as Record<string, unknown>[])[0]!["remote"] =
      "https://github.com/QServices/token-warehouse.git";
    (portableConfig["commands"] as Record<string, unknown>)["test"] = "pnpm test";

    const response = await engine.call(`/v1/projects/${created.id}/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portableConfig, writeToRepository: false }),
    });
    expect(response.status).toBe(200);
  });

  it("allows API routes as domain text but rejects them in path-bearing fields", async () => {
    const engine = await start();
    const root = fixture(() => makeNodeRepositoryFixture());
    const created = (await (await importProject(engine, { repositoryPath: root })).json()) as {
      id: string;
    };
    const portableConfig = parseYaml(
      readFileSync(join(REPO_ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
    ) as Record<string, unknown>;
    const modules = portableConfig["modules"] as Record<string, unknown>[];
    const configuration = modules[1]!["configuration"] as Record<string, unknown>;
    const rules = configuration["rules"] as Record<string, unknown>[];
    const emit = rules[0]!["emit"] as Record<string, unknown>;
    emit["payload"] = { healthRoute: "/health" };

    const valid = await engine.call(`/v1/projects/${created.id}/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portableConfig, writeToRepository: false }),
    });
    expect(valid.status).toBe(200);

    emit["payload"] = { outputPath: "/health" };
    const invalid = await engine.call(`/v1/projects/${created.id}/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portableConfig, writeToRepository: false }),
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: { message: string } }).error.message).not.toContain(
      "/health",
    );
  });

  it("rejects recognizable embedded secret values without echoing them", async () => {
    const engine = await start();
    const root = fixture(() => makeNodeRepositoryFixture());
    const created = (await (await importProject(engine, { repositoryPath: root })).json()) as {
      id: string;
    };
    const portableConfig = parseYaml(
      readFileSync(join(REPO_ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
    ) as Record<string, unknown>;
    for (const secret of [
      "https://user:ghp_abcdefghijklmnopqrstuvwxyz1234567890@example.invalid/repo",
      "https://user:password@example.invalid/repo",
      "Basic dXNlcjpwYXNzd29yZA==",
    ]) {
      setNestedConfigurationValue(portableConfig, secret);
      const response = await engine.call(`/v1/projects/${created.id}/configuration`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ portableConfig, writeToRepository: false }),
      });
      expect(response.status).toBe(400);
      expect(
        ((await response.json()) as { error: { message: string } }).error.message,
      ).not.toContain(secret);
    }
  });

  it("allows an explicit secret reference where the Module contract permits one", async () => {
    const engine = await start();
    const root = fixture(() => makeNodeRepositoryFixture());
    const created = (await (await importProject(engine, { repositoryPath: root })).json()) as {
      id: string;
    };
    const portableConfig = parseYaml(
      readFileSync(join(REPO_ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
    ) as Record<string, unknown>;
    const modules = portableConfig["modules"] as Record<string, unknown>[];
    const configuration = modules[1]!["configuration"] as Record<string, unknown>;
    const rules = configuration["rules"] as Record<string, unknown>[];
    const emit = rules[0]!["emit"] as Record<string, unknown>;
    emit["payload"] = { secretRef: "keychain/project/service" };

    const response = await engine.call(`/v1/projects/${created.id}/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portableConfig, writeToRepository: false }),
    });
    expect(response.status).toBe(200);
  });

  it("gets and replaces schema-valid Local Bindings while preserving the Repository Grant", async () => {
    const engine = await start();
    const root = fixture(() => makeNodeRepositoryFixture());
    const created = (await (await importProject(engine, { repositoryPath: root })).json()) as {
      id: string;
    };
    expect(
      await (await engine.call(`/v1/projects/${created.id}/binding-candidates`)).json(),
    ).toEqual({ items: [] });
    const portableConfig = parseYaml(
      readFileSync(join(REPO_ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
    ) as Record<string, unknown>;
    expect(
      (
        await engine.call(`/v1/projects/${created.id}/configuration`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ portableConfig, writeToRepository: false }),
        })
      ).status,
    ).toBe(200);
    const candidates = await (
      await engine.call(`/v1/projects/${created.id}/binding-candidates`)
    ).json();
    expect(candidates).toEqual({
      items: expect.arrayContaining([
        expect.objectContaining({
          ref: "github",
          kind: "module-instance",
          capabilities: expect.arrayContaining(["scm.change-request.manage"]),
        }),
      ]),
    });

    const initial = (await (
      await engine.call(`/v1/projects/${created.id}/bindings`)
    ).json()) as Record<string, unknown>;
    expect(initial).toEqual({
      apiVersion: "jarvis.dev/project-bindings/v1",
      kind: "ProjectBindings",
      projectId: created.id,
      repositories: {
        main: {
          path: (initial["repositories"] as Record<string, { path: string }>)["main"]!.path,
          bookmarkRef: null,
        },
      },
      slots: {},
    });
    const validateBindings = localApiValidator("ProjectBindings");
    expect(validateBindings(initial), explain(validateBindings)).toBe(true);

    const replacement = {
      ...initial,
      slots: {
        sourceControl: { kind: "module-instance", ref: "github" },
      },
    };
    const response = await engine.call(`/v1/projects/${created.id}/bindings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(replacement),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(replacement);

    const incompatibleConfiguration = structuredClone(portableConfig);
    const modules = incompatibleConfiguration["modules"] as Record<string, unknown>[];
    modules[0]!["enabled"] = false;
    const configurationResponse = await engine.call(`/v1/projects/${created.id}/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        portableConfig: incompatibleConfiguration,
        writeToRepository: false,
      }),
    });
    expect(configurationResponse.status).toBe(400);
    expect(((await configurationResponse.json()) as { error: { code: string } }).error.code).toBe(
      "project.config-invalid",
    );
  });

  it("rejects a Repository Grant smuggled through generic Local Bindings replacement", async () => {
    const engine = await start();
    const root = fixture(() => makeNodeRepositoryFixture());
    const created = (await (await importProject(engine, { repositoryPath: root })).json()) as {
      id: string;
    };
    const before = (await (
      await engine.call(`/v1/projects/${created.id}/bindings`)
    ).json()) as Record<string, unknown>;
    const repositories = structuredClone(before["repositories"]) as Record<
      string,
      { path: string; bookmarkRef: string | null }
    >;
    repositories["main"] = {
      path: fixture(() => makeNodeRepositoryFixture()),
      bookmarkRef: "bookmark/smuggled",
    };

    const response = await engine.call(`/v1/projects/${created.id}/bindings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...before, repositories }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "project.bindings-invalid",
    );
    expect(await (await engine.call(`/v1/projects/${created.id}/bindings`)).json()).toEqual(before);
  });

  it("rejects unknown or capability-incompatible Local Binding refs without changing the persisted envelope", async () => {
    const engine = await start();
    const root = fixture(() => makeNodeRepositoryFixture());
    const portableConfig = parseYaml(
      readFileSync(join(REPO_ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
    ) as Record<string, unknown>;
    const created = (await (
      await importProject(engine, { repositoryPath: root, portableConfig })
    ).json()) as { id: string };
    const before = await (await engine.call(`/v1/projects/${created.id}/bindings`)).json();
    for (const slots of [
      { sourceControl: { kind: "connection", ref: "connection/opaque" } },
      { agentRuntime: { kind: "module-instance", ref: "github" } },
    ]) {
      const response = await engine.call(`/v1/projects/${created.id}/bindings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...(before as Record<string, unknown>), slots }),
      });
      expect(response.status).toBe(400);
      const error = (await response.json()) as { error: { code: string; message: string } };
      expect(error.error.code).toBe("project.bindings-invalid");
      expect(error.error.message).not.toContain("connection/opaque");
    }
    expect(await (await engine.call(`/v1/projects/${created.id}/bindings`)).json()).toEqual(before);
  });

  it("refuses a symlinked .jarvis write target before changing SQLite", async () => {
    const engine = await start();
    const root = fixture(() => makeNodeRepositoryFixture());
    const created = (await (await importProject(engine, { repositoryPath: root })).json()) as {
      id: string;
      portableConfig: unknown;
    };
    const outside = fixture(() => mkdtempSync(join(tmpdir(), "jarvis-write-outside-")));
    symlinkSync(outside, join(root, ".jarvis"), "dir");
    const portableConfig = parseYaml(
      readFileSync(join(REPO_ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
    ) as Record<string, unknown>;

    const response = await engine.call(`/v1/projects/${created.id}/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portableConfig, writeToRepository: true }),
    });
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "project.repository-write-failed",
    );
    expect(existsSync(join(outside, "project.yaml"))).toBe(false);
    expect(await (await engine.call(`/v1/projects/${created.id}`)).json()).toMatchObject({
      portableConfig: created.portableConfig,
    });
  });

  it("atomically writes portable YAML only when explicitly requested and does not commit it", async () => {
    const engine = await start();
    const root = fixture(() => makeNodeRepositoryFixture());
    execFileSync("git", ["-C", root, "init"]);
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=Jarvis Test",
      "-c",
      "user.email=test@jarvis.dev",
      "commit",
      "-m",
      "fixture",
    ]);
    const created = (await (await importProject(engine, { repositoryPath: root })).json()) as {
      id: string;
    };
    const portableConfig = parseYaml(
      readFileSync(join(REPO_ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
    ) as Record<string, unknown>;
    const beforeHead = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    });

    const response = await engine.call(`/v1/projects/${created.id}/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portableConfig, writeToRepository: true }),
    });
    expect(response.status).toBe(200);
    expect(parseYaml(readFileSync(join(root, ".jarvis", "project.yaml"), "utf8"))).toEqual(
      portableConfig,
    );
    expect(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" })).toBe(
      beforeHead,
    );
    expect(execFileSync("git", ["-C", root, "status", "--short"], { encoding: "utf8" })).toContain(
      ".jarvis/",
    );
  });

  it("persists a Repository Grant path resolved after the repository moves", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "jarvis-project-grant-"));
    const root = fixture(() => makeNodeRepositoryFixture());
    const moved = `${root}-moved`;
    try {
      const first = await start({ dataRoot });
      const created = (await (await importProject(first, { repositoryPath: root })).json()) as {
        id: string;
      };
      renameSync(root, moved);
      roots.push(moved);

      const update = await first.call(`/v1/projects/${created.id}/repositories/main/binding`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: moved,
          bookmarkRef: `bookmark/${created.id}/main`,
        }),
      });
      expect(update.status).toBe(200);
      const updated = (await update.json()) as {
        bindingStatus: Record<string, { path: string; accessible: boolean; bookmarkRef: string }>;
      };
      await first.dispose();

      const second = await start({ dataRoot });
      started.push(second);
      const detail = (await (await second.call(`/v1/projects/${created.id}`)).json()) as {
        bindingStatus: Record<string, { path: string; accessible: boolean }>;
      };
      expect(detail.bindingStatus["main"]).toEqual({
        path: updated.bindingStatus["main"]?.path,
        accessible: true,
        bookmarkRef: `bookmark/${created.id}/main`,
      });
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
