import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import type { Clock } from "../../../../packages/kernel/src/clock.js";
import { SavedProjectCompositionValidator } from "../../../../packages/project-runtime/src/composition-validator.js";
import { LocalRepositoryAccessibility } from "./repository-accessibility.js";
import type { ProjectResourceGrantPort } from "../../../../packages/project-runtime/src/project-types.js";
import {
  ModuleHost,
  ModuleManifestContractRegistry,
  type ModulePackageRegistry,
} from "../../../../packages/kernel/src/module-host.js";
import type { PortableProjectConfiguration } from "../../../../packages/project-runtime/src/project-types.js";
import {
  AtomicProjectConfigurationWriter,
  type ProjectConfigurationWriter,
} from "./repository-config-writer.js";
import { EmptyProjectResourceGrants } from "./resource-grants.js";
import { ProjectService } from "./service.js";
import { ProjectStore } from "./store.js";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const roots: string[] = [];
const databases: Database.Database[] = [];
const clock: Clock = { now: () => new Date("2026-02-03T04:05:06.000Z") };

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Project configuration replacement", () => {
  it("rejects a symlinked destination before reading or replacing it", () => {
    const repository = mkdtempSync(join(tmpdir(), "jarvis-symlinked-config-"));
    roots.push(repository);
    mkdirSync(join(repository, ".jarvis"));
    const outside = join(repository, "outside.yaml");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(repository, ".jarvis", "project.yaml"));

    expect(() =>
      new AtomicProjectConfigurationWriter().write(repository, exampleConfiguration()),
    ).toThrowError(expect.objectContaining({ code: "project.repository-write-failed" }));
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  it("accepts only an explicitly granted external candidate with the required capability", () => {
    const repository = mkdtempSync(join(tmpdir(), "jarvis-explicit-grant-"));
    roots.push(repository);
    const db = projectDatabase();
    databases.push(db);
    const store = new ProjectStore(db, clock);
    const configuration = exampleConfiguration();
    store.createProject({
      id: "token-warehouse",
      name: configuration.metadata.name,
      status: "draft",
      portableConfig: configuration,
      repositoryPath: repository,
    });
    const grants: ProjectResourceGrantPort = {
      grantedToProject: () => [
        {
          ref: "runtime/codex-test",
          kind: "runtime",
          displayName: "Test runtime grant",
          capabilities: ["agent.execute"],
        },
      ],
    };
    const service = new ProjectService(
      store,
      moduleHost(),
      new AtomicProjectConfigurationWriter(),
      grants,
      new SavedProjectCompositionValidator(moduleHost()),
      new LocalRepositoryAccessibility(),
    );

    expect(service.listProjectResourceCandidates("token-warehouse")).toContainEqual(
      expect.objectContaining({ ref: "runtime/codex-test", kind: "runtime" }),
    );
    expect(
      service.replaceProjectBindings({
        projectId: "token-warehouse",
        bindings: {
          apiVersion: "jarvis.dev/project-bindings/v1",
          kind: "ProjectBindings",
          projectId: "token-warehouse",
          repositories: { main: { path: repository, bookmarkRef: null } },
          slots: {
            agentRuntime: { kind: "runtime", ref: "runtime/codex-test" },
          },
        },
      }),
    ).toMatchObject({
      slots: { agentRuntime: { kind: "runtime", ref: "runtime/codex-test" } },
    });
  });

  it("removes a first repository file when SQLite fails after writing it", () => {
    const repository = mkdtempSync(join(tmpdir(), "jarvis-first-write-compensation-"));
    roots.push(repository);
    const projectFile = join(repository, ".jarvis", "project.yaml");
    const db = projectDatabase();
    databases.push(db);
    const store = new ProjectStore(db, clock);
    const configuration = exampleConfiguration();
    store.createProject({
      id: "token-warehouse",
      name: "Before",
      status: "draft",
      portableConfig: { ...configuration, metadata: { ...configuration.metadata, name: "Before" } },
      repositoryPath: repository,
    });
    db.exec(`CREATE TRIGGER fail_first_project_update BEFORE UPDATE ON projects
      BEGIN SELECT RAISE(ABORT, 'injected SQLite failure'); END`);
    const service = new ProjectService(
      store,
      moduleHost(),
      new AtomicProjectConfigurationWriter(),
      new EmptyProjectResourceGrants(),
      new SavedProjectCompositionValidator(moduleHost()),
      new LocalRepositoryAccessibility(),
    );

    expect(() =>
      service.replaceProjectConfiguration({
        projectId: "token-warehouse",
        portableConfig: configuration,
        writeToRepository: true,
      }),
    ).toThrow("injected SQLite failure");
    expect(existsSync(projectFile)).toBe(false);
    expect(store.findById("token-warehouse")?.name).toBe("Before");
  });

  it("reports a stable compensation error when a first-file cleanup fails", () => {
    const repository = mkdtempSync(join(tmpdir(), "jarvis-first-cleanup-failure-"));
    roots.push(repository);
    const projectFile = join(repository, ".jarvis", "project.yaml");
    const db = projectDatabase();
    databases.push(db);
    const store = new ProjectStore(db, clock);
    const configuration = exampleConfiguration();
    store.createProject({
      id: "token-warehouse",
      name: "Before",
      status: "draft",
      portableConfig: { ...configuration, metadata: { ...configuration.metadata, name: "Before" } },
      repositoryPath: repository,
    });
    db.exec(`CREATE TRIGGER fail_cleanup_project_update BEFORE UPDATE ON projects
      BEGIN SELECT RAISE(ABORT, 'injected SQLite failure'); END`);
    const atomic = new AtomicProjectConfigurationWriter();
    const cleanupFailure: ProjectConfigurationWriter = {
      write: (path, next) => {
        const compensation = atomic.write(path, next);
        rmSync(projectFile);
        mkdirSync(projectFile);
        return compensation;
      },
    };
    const service = new ProjectService(
      store,
      moduleHost(),
      cleanupFailure,
      new EmptyProjectResourceGrants(),
      new SavedProjectCompositionValidator(moduleHost()),
      new LocalRepositoryAccessibility(),
    );

    expect(() =>
      service.replaceProjectConfiguration({
        projectId: "token-warehouse",
        portableConfig: configuration,
        writeToRepository: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "project.repository-compensation-failed" }));
    expect(store.findById("token-warehouse")?.name).toBe("Before");
  });

  it("restores the repository file when SQLite fails after the file replacement", () => {
    const repository = mkdtempSync(join(tmpdir(), "jarvis-compensation-"));
    roots.push(repository);
    mkdirSync(join(repository, ".jarvis"));
    const projectFile = join(repository, ".jarvis", "project.yaml");
    const previousFile = "# last durable configuration\n";
    writeFileSync(projectFile, previousFile);

    const db = projectDatabase();
    databases.push(db);
    const store = new ProjectStore(db, clock);
    const configuration = exampleConfiguration();
    store.createProject({
      id: "token-warehouse",
      name: "Before",
      status: "draft",
      portableConfig: { ...configuration, metadata: { ...configuration.metadata, name: "Before" } },
      repositoryPath: repository,
    });
    db.exec(`CREATE TRIGGER fail_project_update BEFORE UPDATE ON projects
      BEGIN SELECT RAISE(ABORT, 'injected SQLite failure'); END`);
    const service = new ProjectService(
      store,
      moduleHost(),
      new AtomicProjectConfigurationWriter(),
      new EmptyProjectResourceGrants(),
      new SavedProjectCompositionValidator(moduleHost()),
      new LocalRepositoryAccessibility(),
    );

    expect(() =>
      service.replaceProjectConfiguration({
        projectId: "token-warehouse",
        portableConfig: configuration,
        writeToRepository: true,
      }),
    ).toThrow("injected SQLite failure");

    expect(readFileSync(projectFile, "utf8")).toBe(previousFile);
    expect(store.findById("token-warehouse")?.name).toBe("Before");

    const failedCompensation: ProjectConfigurationWriter = {
      write: () => ({
        restore: () => {
          throw new Error("injected restoration failure");
        },
      }),
    };
    const unsafeService = new ProjectService(
      store,
      moduleHost(),
      failedCompensation,
      new EmptyProjectResourceGrants(),
      new SavedProjectCompositionValidator(moduleHost()),
      new LocalRepositoryAccessibility(),
    );
    expect(() =>
      unsafeService.replaceProjectConfiguration({
        projectId: "token-warehouse",
        portableConfig: configuration,
        writeToRepository: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "project.repository-compensation-failed" }));
  });
});

describe("Project deletion", () => {
  it("owns status validation and deletion inside one service transaction", () => {
    const db = projectDatabase();
    databases.push(db);
    const store = new ProjectStore(db, clock);
    const configuration = exampleConfiguration();
    const repository = mkdtempSync(join(tmpdir(), "jarvis-active-delete-"));
    roots.push(repository);
    store.createProject({
      id: "active-project",
      name: "Active",
      status: "active",
      portableConfig: configuration,
      repositoryPath: repository,
    });
    const service = new ProjectService(
      store,
      moduleHost(),
      new AtomicProjectConfigurationWriter(),
      new EmptyProjectResourceGrants(),
      new SavedProjectCompositionValidator(moduleHost()),
      new LocalRepositoryAccessibility(),
    );

    expect(() => service.deleteProject("active-project")).toThrowError(
      expect.objectContaining({ code: "project.active" }),
    );
    expect(store.findById("active-project")).toBeDefined();
    expect(() => service.deleteProject("unknown")).toThrowError(
      expect.objectContaining({ code: "project.not-found" }),
    );

    db.prepare("UPDATE projects SET status = 'paused' WHERE id = ?").run("active-project");
    service.deleteProject("active-project");
    expect(store.findById("active-project")).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM project_bindings WHERE project_id = ?").get("active-project"),
    ).toBeUndefined();
  });
});

function projectDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
      portable_config TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE project_bindings (
      project_id TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE, repository_path TEXT NOT NULL,
      bookmark_ref TEXT, slot_bindings TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(slot_bindings))
    ) STRICT;
  `);
  return db;
}

function exampleConfiguration(): PortableProjectConfiguration {
  return parseYaml(
    readFileSync(join(ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
  ) as PortableProjectConfiguration;
}

function moduleHost(): ModuleHost {
  const names = ["github", "automation-rules", "development"];
  const registry: ModulePackageRegistry = {
    discover: () =>
      names.map((packageName) => ({
        packageName,
        source: "test",
        document: parseYaml(
          readFileSync(join(ROOT, `packages/modules/${packageName}/module.manifest.yaml`), "utf8"),
        ) as unknown,
      })),
    readConfigurationSchema: (schemaRef) =>
      JSON.parse(readFileSync(join(ROOT, schemaRef), "utf8")) as unknown,
  };
  const contract = JSON.parse(
    readFileSync(join(ROOT, "contracts/schemas/module-manifest.v1.schema.json"), "utf8"),
  ) as object;
  return new ModuleHost(
    registry,
    new ModuleManifestContractRegistry({ moduleManifestV1: contract }),
  );
}
