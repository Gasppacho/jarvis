import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { EmptyProjectResourceGrants } from "./resource-grants.js";
import { ProjectService } from "./service.js";
import { ProjectStore } from "./store.js";
import { EventJournalReader } from "../events/timeline.js";
import { ExecutionLedgerReader } from "../executions/ledger.js";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const roots: string[] = [];
const databases: Database.Database[] = [];
const clock: Clock = { now: () => new Date("2026-02-03T04:05:06.000Z") };

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Project configuration replacement", () => {
  it("saves structural changes while preserving an active Project status", () => {
    const repository = mkdtempSync(join(tmpdir(), "jarvis-active-composition-"));
    roots.push(repository);
    const db = projectDatabase();
    databases.push(db);
    const store = new ProjectStore(db, clock);
    const configuration = exampleConfiguration();
    store.createProject({
      id: "active-project",
      name: configuration.metadata.name,
      status: "active",
      portableConfig: configuration,
      repositoryPath: repository,
    });
    const service = new ProjectService(
      store,
      moduleHost(),
      new EmptyProjectResourceGrants(),
      new SavedProjectCompositionValidator(moduleHost()),
      new LocalRepositoryAccessibility(),
      new EventJournalReader(db),
      new ExecutionLedgerReader(db),
    );
    const proposed = {
      ...configuration,
      modules: configuration.modules.slice(1),
    };

    service.replaceProjectConfiguration({
      projectId: "active-project",
      portableConfig: proposed,
      writeToRepository: false,
    });
    expect(store.findById("active-project")).toMatchObject({
      status: "active",
      portableConfig: proposed,
    });
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
    let grantIsAccessible = true;
    const grants: ProjectResourceGrantPort = {
      grantedToProject: (projectId) =>
        projectId === "token-warehouse" && grantIsAccessible
          ? [
              {
                ref: "runtime/codex-test",
                kind: "runtime" as const,
                displayName: "Test runtime grant",
                capabilities: ["agent.execute"],
              },
              {
                ref: "runtime/incompatible",
                kind: "runtime" as const,
                displayName: "Incompatible runtime grant",
                capabilities: ["shell.execute"],
              },
            ]
          : [],
    };
    const service = new ProjectService(
      store,
      moduleHost(),
      grants,
      new SavedProjectCompositionValidator(moduleHost()),
      new LocalRepositoryAccessibility(),
      new EventJournalReader(db),
      new ExecutionLedgerReader(db),
    );

    const choices = service.getProjectResourceChoices("token-warehouse");
    expect(choices.items).toContainEqual(
      expect.objectContaining({ ref: "runtime/codex-test", kind: "runtime" }),
    );
    expect(choices.items).not.toContainEqual(
      expect.objectContaining({ ref: "runtime/incompatible" }),
    );
    expect(choices.slots.find((slot) => slot.slotId === "agentRuntime")).toMatchObject({
      requiredCapabilities: ["agent.execute"],
      status: "available",
      candidates: [expect.objectContaining({ ref: "runtime/codex-test" })],
    });
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
    expect(() =>
      service.replaceProjectBindings({
        projectId: "token-warehouse",
        bindings: {
          apiVersion: "jarvis.dev/project-bindings/v1",
          kind: "ProjectBindings",
          projectId: "token-warehouse",
          repositories: { main: { path: repository, bookmarkRef: null } },
          slots: {
            agentRuntime: {
              kind: "runtime",
              ref: "runtime/codex-test",
              environment: { GH_PAT: "github_pat_0123456789_abcdefghijklmnopqrstuvwxyz" },
            },
          },
        },
      }),
    ).toThrow("must not contain secrets");
    grantIsAccessible = false;
    expect(service.getProjectResourceChoices("token-warehouse").slots).toContainEqual(
      expect.objectContaining({ slotId: "agentRuntime", status: "inaccessible" }),
    );
  });

  it("never creates a repository file when the local save fails", () => {
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
      new EmptyProjectResourceGrants(),
      new SavedProjectCompositionValidator(moduleHost()),
      new LocalRepositoryAccessibility(),
      new EventJournalReader(db),
      new ExecutionLedgerReader(db),
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
});

describe("Project verification persistence", () => {
  it("rejects a stored report that does not satisfy the preflight boundary", () => {
    const db = projectDatabase();
    databases.push(db);
    const store = new ProjectStore(db, clock);
    const configuration = exampleConfiguration();
    store.createProject({
      id: "invalid-verification",
      name: "Invalid verification",
      status: "draft",
      portableConfig: configuration,
      repositoryPath: "/tmp/invalid-verification",
    });
    db.prepare(
      `INSERT INTO project_verifications
         (project_id, verification_fingerprint, report, verified_at)
       VALUES (?, ?, ?, ?)`,
    ).run("invalid-verification", "fingerprint", "{}", clock.now().toISOString());

    expect(() => store.getProjectVerification("invalid-verification")).toThrow(
      "Stored Project verification is invalid.",
    );
  });
});

describe("Project deletion", () => {
  it("auto-pauses idle Projects and blocks active work", () => {
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
      new EmptyProjectResourceGrants(),
      new SavedProjectCompositionValidator(moduleHost()),
      new LocalRepositoryAccessibility(),
      new EventJournalReader(db),
      new ExecutionLedgerReader(db),
    );

    service.deleteProject("active-project");
    expect(store.findById("active-project")).toBeUndefined();
    expect(() => service.deleteProject("unknown")).toThrowError(
      expect.objectContaining({ code: "project.not-found" }),
    );

    store.createProject({
      id: "busy-project",
      name: "Busy",
      status: "active",
      portableConfig: configuration,
      repositoryPath: `${repository}-busy`,
    });
    db.prepare("INSERT INTO executions (project_id, status) VALUES (?, 'running')").run(
      "busy-project",
    );
    expect(() => service.deleteProject("busy-project")).toThrowError(
      expect.objectContaining({ code: "project.active" }),
    );
    expect(store.findById("busy-project")).toBeDefined();
    expect(
      db.prepare("SELECT 1 FROM project_bindings WHERE project_id = ?").get("active-project"),
    ).toBeUndefined();
  });
});

describe("Granted-but-ineligible resource disclosure (ADR 0014)", () => {
  it("names each permitted ineligible case with the Engine's reason and never leaks another Project's grant", () => {
    const repository = mkdtempSync(join(tmpdir(), "jarvis-ineligible-disclosure-"));
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

    const OTHER_PROJECT_REF = "runtime/other-project-secret";
    const grants: ProjectResourceGrantPort = {
      grantedToProject: (projectId) => {
        if (projectId === "token-warehouse") {
          return [
            // Eligible: fully satisfies agentRuntime, bound below -> "bound".
            {
              ref: "runtime/codex-primary",
              kind: "runtime" as const,
              displayName: "Primary runtime",
              capabilities: ["agent.execute"],
            },
            // Same ref as the bound resource above, but the wrong `kind`.
            {
              ref: "runtime/codex-primary",
              kind: "connection" as const,
              displayName: "Mistyped runtime registration",
              capabilities: ["agent.execute"],
            },
            // sourceControl requires both github.api and scm.change-request.manage:
            // this grant provides only one -> partial capability match.
            {
              ref: "connection/github-partial",
              kind: "connection" as const,
              displayName: "GitHub, half-scoped",
              capabilities: ["scm.change-request.manage"],
            },
            // tickets requires work-items.read: this grant provides neither it
            // nor anything else required -> missing capability.
            {
              ref: "mcp/wrong-tool",
              kind: "mcp" as const,
              displayName: "Unrelated ticket tool",
              capabilities: ["issue.export"],
            },
          ];
        }
        if (projectId === "other-project") {
          return [
            {
              ref: OTHER_PROJECT_REF,
              kind: "runtime" as const,
              displayName: "Other Project's secret runtime",
              capabilities: ["agent.execute"],
            },
          ];
        }
        return [];
      },
    };

    const service = new ProjectService(
      store,
      moduleHost(),
      grants,
      new SavedProjectCompositionValidator(moduleHost()),
      new LocalRepositoryAccessibility(),
      new EventJournalReader(db),
      new ExecutionLedgerReader(db),
    );

    service.replaceProjectBindings({
      projectId: "token-warehouse",
      bindings: {
        apiVersion: "jarvis.dev/project-bindings/v1",
        kind: "ProjectBindings",
        projectId: "token-warehouse",
        repositories: { main: { path: repository, bookmarkRef: null } },
        slots: {
          agentRuntime: { kind: "runtime", ref: "runtime/codex-primary" },
        },
      },
    });

    const choices = service.getProjectResourceChoices("token-warehouse");

    // Eligible resource carries its status.
    const agentRuntime = choices.slots.find((slot) => slot.slotId === "agentRuntime");
    expect(agentRuntime).toMatchObject({ status: "bound" });
    expect(agentRuntime?.candidates).toContainEqual(
      expect.objectContaining({ ref: "runtime/codex-primary", kind: "runtime" }),
    );

    // Wrong kind: named on the Slot it was bound for, absent from its candidates.
    expect(agentRuntime?.candidates).not.toContainEqual(
      expect.objectContaining({ kind: "connection", ref: "runtime/codex-primary" }),
    );
    expect(agentRuntime?.ineligibleGrantedResources).toContainEqual(
      expect.objectContaining({
        candidate: expect.objectContaining({ kind: "connection", ref: "runtime/codex-primary" }),
        reason: expect.stringContaining('kind "connection"'),
      }),
    );

    // Partial capability match: named on sourceControl, absent from its candidates.
    const sourceControl = choices.slots.find((slot) => slot.slotId === "sourceControl");
    expect(sourceControl?.candidates).not.toContainEqual(
      expect.objectContaining({ ref: "connection/github-partial" }),
    );
    expect(sourceControl?.ineligibleGrantedResources).toContainEqual(
      expect.objectContaining({
        candidate: expect.objectContaining({ ref: "connection/github-partial" }),
        reason: expect.stringContaining("scm.change-request.manage"),
      }),
    );

    // Missing capability entirely: named on tickets, absent from its candidates.
    const tickets = choices.slots.find((slot) => slot.slotId === "tickets");
    expect(tickets?.candidates).not.toContainEqual(
      expect.objectContaining({ ref: "mcp/wrong-tool" }),
    );
    expect(tickets?.ineligibleGrantedResources).toContainEqual(
      expect.objectContaining({
        candidate: expect.objectContaining({ ref: "mcp/wrong-tool" }),
        reason: expect.stringContaining("none of the required capabilities"),
      }),
    );

    // Deterministic, ordered by Slot.
    expect(choices.slots.map((slot) => slot.slotId)).toEqual(
      [...choices.slots.map((slot) => slot.slotId)].sort((left, right) =>
        left.localeCompare(right),
      ),
    );
    expect(service.getProjectResourceChoices("token-warehouse")).toEqual(choices);

    // A resource granted to another Project, never this one, is absent everywhere,
    // not merely from the candidate arrays.
    expect(JSON.stringify(choices)).not.toContain(OTHER_PROJECT_REF);
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
    CREATE TABLE project_verifications (
      project_id TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
      verification_fingerprint TEXT NOT NULL, report TEXT NOT NULL, verified_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE executions (
      project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE deliveries (
      project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
      consumed_at TEXT
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
  const names = ["github", "automation-rules", "development", "pull-request"];
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
    readEventSchema: (schemaRef) =>
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
