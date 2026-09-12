import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeDescriptor } from "../../../packages/agent-runtime/src/index.js";
import type { PortableProjectConfiguration } from "../../../packages/project-runtime/src/project-types.js";
import { ExecutionCheckpointStore } from "../src/executions/checkpoints.js";
import { ConnectionDescriptorStore } from "../src/connections/registry.js";
import { RuntimeDescriptorStore } from "../src/runtimes/registry.js";
import { startEngine, type Harness } from "./harness.js";
import {
  makeRealGitRepositoryFixture,
  type RealGitRepositoryFixture,
} from "./repository-fixture.js";

const testBundlePath = fileURLToPath(
  new URL("../../../dist/engine/engine.test-bundle.mjs", import.meta.url),
);
const FAKE_RUNTIME_REF = "runtime/fake-test";
const CODEX_RUNTIME_REF = "runtime/codex-default";

interface ExecutionSummary {
  readonly id: string;
  readonly moduleInstanceId: string;
  readonly status: string;
}

interface AgentObservation {
  readonly cwd: string;
  readonly environment: Record<string, string>;
}

interface DevelopmentResult {
  readonly status: string;
  readonly headCommit: string;
  readonly changedFiles: readonly string[];
}

describe("runtime isolation acceptance", () => {
  const engines: Harness[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("isolates two project-bound runtimes in one real engine session", async () => {
    const projectA = "runtime-isolation-a";
    const projectB = "runtime-isolation-b";
    const projectAOnly = "project-a-only-value";
    const projectBOnly = "project-b-only-value";
    const projectBPath = process.env["PATH"] ?? "/usr/bin";
    const engineOnly = "engine-only-value";
    const secret = "runtime-isolation-secret";
    const fixtureA = makeRealGitRepositoryFixture();
    const fixtureB = makeRealGitRepositoryFixture();
    roots.push(fixtureA.root, fixtureA.remoteRoot, fixtureB.root, fixtureB.remoteRoot);

    const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-ri-"));
    roots.push(dataRoot);
    const fakeCodexPath = join(dataRoot, "fake-codex");
    writeFakeCodex(fakeCodexPath);

    const engine = await startEngine({
      dataRoot,
      enginePath: testBundlePath,
      env: {
        JARVIS_ENABLE_TEST_HOOKS: "1",
        JARVIS_FAKE_SCENARIO: "inspect",
        JARVIS_PROJECT_A_ONLY: projectAOnly,
        JARVIS_PROJECT_B_ONLY: projectBOnly,
        JARVIS_ENGINE_ONLY: engineOnly,
        JARVIS_ISOLATION_SECRET: secret,
      },
    });
    engines.push(engine);
    seedCodexRuntime(dataRoot, fakeCodexPath);
    seedGitHubConnection(dataRoot);

    await activateProject(
      engine,
      projectA,
      fixtureA,
      FAKE_RUNTIME_REF,
      ["JARVIS_FAKE_SCENARIO", "JARVIS_PROJECT_A_ONLY"],
      { JARVIS_FAKE_SCENARIO: "inspect", JARVIS_PROJECT_A_ONLY: projectAOnly },
    );
    await activateProject(
      engine,
      projectB,
      fixtureB,
      CODEX_RUNTIME_REF,
      ["PATH", "JARVIS_PROJECT_B_ONLY"],
      { PATH: projectBPath, JARVIS_PROJECT_B_ONLY: projectBOnly },
    );

    const [bindingsA, bindingsB] = await Promise.all([
      readBindings(engine, projectA),
      readBindings(engine, projectB),
    ]);
    expect(bindingsA).toMatchObject({ kind: "runtime", ref: FAKE_RUNTIME_REF });
    expect(bindingsB).toMatchObject({ kind: "runtime", ref: CODEX_RUNTIME_REF });

    await Promise.all([
      publishTag(engine, projectA, "isolation-a"),
      publishTag(engine, projectB, "isolation-b"),
    ]);
    const [executionsA, executionsB] = await Promise.all([
      waitForTerminalExecutions(engine, projectA),
      waitForTerminalExecutions(engine, projectB),
    ]);
    expect(executionsA.every(({ status }) => status === "completed")).toBe(true);
    expect(executionsB.every(({ status }) => status === "completed")).toBe(true);

    const developmentA = developmentExecution(executionsA);
    const developmentB = developmentExecution(executionsB);
    const canonicalDataRoot = realpathSync(dataRoot);
    const workspaceA = join(canonicalDataRoot, "projects", projectA, "workspaces", developmentA.id);
    const workspaceB = join(canonicalDataRoot, "projects", projectB, "workspaces", developmentB.id);
    expect(workspaceA).not.toBe(workspaceB);

    const database = new Database(join(dataRoot, "jarvis.sqlite"), { readonly: true });
    try {
      const resultA = readDevelopmentResult(database, projectA);
      const resultB = readDevelopmentResult(database, projectB);
      expect(resultA).toMatchObject({
        status: "completed",
        changedFiles: ["fake-runtime-working-directory.txt"],
      });
      expect(resultB).toMatchObject({
        status: "completed",
        changedFiles: ["codex-runtime-observation.json"],
      });

      const observationA = readAgentObservation(database, projectA, developmentA.id);
      const observationB = readAgentObservation(database, projectB, developmentB.id);
      expect(observationA.environment).toEqual({
        JARVIS_FAKE_SCENARIO: "inspect",
        JARVIS_PROJECT_A_ONLY: projectAOnly,
      });
      expect(observationB.environment).toEqual({
        PATH: "./node_modules/.bin:<path>",
        JARVIS_PROJECT_B_ONLY: projectBOnly,
      });
      expect(observationA.environment).not.toHaveProperty("JARVIS_PROJECT_B_ONLY");
      expect(observationB.environment).not.toHaveProperty("JARVIS_PROJECT_A_ONLY");
      for (const observation of [observationA, observationB]) {
        expect(observation.environment).not.toHaveProperty("JARVIS_ENGINE_ONLY");
        expect(observation.environment).not.toHaveProperty("JARVIS_ISOLATION_SECRET");
      }

      const artifactA = readRemoteArtifact(
        fixtureA,
        resultA.headCommit,
        "fake-runtime-working-directory.txt",
      );
      const artifactB = readRemoteArtifact(
        fixtureB,
        resultB.headCommit,
        "codex-runtime-observation.json",
      );
      expect(artifactA).toBe(workspaceA);
      const persistedObservationB = JSON.parse(artifactB) as AgentObservation;
      expect(persistedObservationB).toEqual({
        cwd: workspaceB,
        environment: { PATH: projectBPath, JARVIS_PROJECT_B_ONLY: projectBOnly },
      });
      expect(observationA.cwd).toBe("<workspace>");
      expect(persistedObservationB.cwd).toBe(workspaceB);

      const projectSurfaceA = projectDatabaseSurface(database, projectA);
      const projectSurfaceB = projectDatabaseSurface(database, projectB);
      expectProjectSurfaceIsolated(
        projectSurfaceA,
        projectA,
        projectB,
        CODEX_RUNTIME_REF,
        fakeCodexPath,
        secret,
        workspaceB,
      );
      expectProjectSurfaceIsolated(
        projectSurfaceB,
        projectB,
        projectA,
        FAKE_RUNTIME_REF,
        fakeCodexPath,
        secret,
        workspaceA,
      );
      expect(projectSurfaceA).toContain(FAKE_RUNTIME_REF);
      expect(projectSurfaceB).toContain(CODEX_RUNTIME_REF);

      const allPersistedText = databaseText(database);
      expect(allPersistedText).not.toContain(secret);
      expect(engine.stderr()).not.toContain(fakeCodexPath);
      expect(engine.stderr()).not.toContain(secret);
      expect(engine.stderr()).not.toContain(homedir());
      for (const line of engine.stderr().split(/\r?\n/).filter(Boolean)) {
        if (line.includes(projectA)) {
          expect(line).not.toContain(projectB);
          expect(line).not.toContain(CODEX_RUNTIME_REF);
        }
        if (line.includes(projectB)) {
          expect(line).not.toContain(projectA);
          expect(line).not.toContain(FAKE_RUNTIME_REF);
        }
      }
    } finally {
      database.close();
    }
  });
});

async function activateProject(
  engine: Harness,
  projectId: string,
  fixture: RealGitRepositoryFixture,
  runtimeRef: string,
  environmentAllowlist: readonly string[],
  runtimeEnvironment: Readonly<Record<string, string>>,
): Promise<void> {
  const portableConfig: PortableProjectConfiguration = {
    apiVersion: "jarvis.dev/project/v1",
    kind: "Project",
    metadata: { id: projectId, name: projectId },
    repositories: [{ id: "main", root: ".", defaultBranch: "main", remote: "origin" }],
    slots: {
      agentRuntime: { requires: "agent.execute" },
      tickets: { requires: "work-items.read" },
    },
    commands: { test: "node --test" },
    git: {
      branchPattern: "agent/{workItemId}-{slug}",
      commitStrategy: "conventional",
      pushRemote: "origin",
      allowForcePush: false,
    },
    workspace: {
      strategy: "git-worktree",
      maxConcurrentExecutions: 2,
      retainOnFailureDays: 7,
    },
    modules: [
      {
        instanceId: "automation-rules",
        moduleId: "jarvis.module.automation-rules",
        enabled: true,
        configuration: {
          rules: [
            {
              id: "ready-label-starts-development",
              when: {
                eventType: "scm.work-item.tag-added",
                equals: { "payload.tag": "agent:ready" },
              },
              emit: {
                type: "development.implementation.requested",
                target: { moduleInstanceId: "development" },
              },
            },
          ],
        },
      },
      {
        instanceId: "development",
        moduleId: "jarvis.module.development",
        enabled: true,
        runtimeSlot: "agentRuntime",
        bindings: { repository: "main", tickets: "tickets" },
        configuration: {
          validationOrder: ["test"],
          maxRepairCycles: 0,
          preparation: "none",
          retainWorkspaceOnSuccess: true,
          timeoutMs: 300_000,
          outputLimitBytes: 1_048_576,
          environmentAllowlist: [...environmentAllowlist],
        },
      },
      {
        instanceId: "request-worker",
        moduleId: "jarvis.module.test-request-worker",
        enabled: true,
      },
    ],
  };
  const imported = await engine.call("/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryPath: fixture.root, portableConfig }),
  });
  expect(imported.status, await imported.clone().text()).toBe(201);

  const repositoryBinding = await engine.call(
    `/v1/projects/${projectId}/repositories/main/binding`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: realpathSync(fixture.root),
        bookmarkRef: `bookmark/${projectId}`,
      }),
    },
  );
  expect(repositoryBinding.status, await repositoryBinding.clone().text()).toBe(200);

  const bindings = await engine.call(`/v1/projects/${projectId}/bindings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      apiVersion: "jarvis.dev/project-bindings/v1",
      kind: "ProjectBindings",
      projectId,
      repositories: {
        main: { path: realpathSync(fixture.root), bookmarkRef: `bookmark/${projectId}` },
      },
      slots: {
        agentRuntime: {
          kind: "runtime",
          ref: runtimeRef,
          environment: runtimeEnvironment,
        },
        tickets: { kind: "connection", ref: "connection/github-work-items" },
      },
    }),
  });
  expect(bindings.status, await bindings.clone().text()).toBe(200);

  const reportResponse = await engine.call(`/v1/projects/${projectId}/validation-report`, {
    method: "POST",
  });
  const report = (await reportResponse.json()) as {
    valid: boolean;
    compositionFingerprint?: string;
  };
  expect(reportResponse.status, JSON.stringify(report)).toBe(200);
  expect(report.valid, JSON.stringify(report)).toBe(true);

  const activated = await engine.call(`/v1/projects/${projectId}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ compositionFingerprint: report.compositionFingerprint }),
  });
  expect(activated.status, await activated.clone().text()).toBe(200);
}

async function readBindings(
  engine: Harness,
  projectId: string,
): Promise<{ kind: string; ref: string }> {
  const response = await engine.call(`/v1/projects/${projectId}/bindings`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    slots: { agentRuntime: { kind: string; ref: string } };
  };
  return body.slots.agentRuntime;
}

async function publishTag(engine: Harness, projectId: string, suffix: string): Promise<void> {
  const response = await engine.call("/test/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "scm.work-item.tag-added",
      version: 1,
      kind: "fact",
      projectId,
      repositoryId: "main",
      producer: { moduleId: "jarvis.module.github", moduleInstanceId: "github" },
      subject: { type: "work-item", ref: `fixture://${projectId}/${suffix}` },
      correlationId: `corr_${projectId}`,
      causationId: null,
      payload: { workItemRef: `fixture://${projectId}/${suffix}`, tag: "agent:ready" },
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
}

async function waitForTerminalExecutions(
  engine: Harness,
  projectId: string,
): Promise<readonly ExecutionSummary[]> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const response = await engine.call(`/v1/projects/${projectId}/executions`);
    const body = (await response.json()) as { items: ExecutionSummary[] };
    if (
      body.items.length >= 2 &&
      body.items.every(({ status }) =>
        ["completed", "failed", "cancelled", "timed-out"].includes(status),
      )
    ) {
      return body.items;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Executions for ${projectId} did not reach a terminal state.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function developmentExecution(executions: readonly ExecutionSummary[]): ExecutionSummary {
  const execution = executions.find(({ moduleInstanceId }) => moduleInstanceId === "development");
  expect(execution).toBeDefined();
  return execution!;
}

function readDevelopmentResult(database: Database.Database, projectId: string): DevelopmentResult {
  const row = database
    .prepare("SELECT result FROM inbox WHERE project_id = ? AND module_instance_id = 'development'")
    .get(projectId) as { result: string } | undefined;
  expect(row).toBeDefined();
  return JSON.parse(row!.result) as DevelopmentResult;
}

function readAgentObservation(
  database: Database.Database,
  projectId: string,
  executionId: string,
): AgentObservation {
  const messages = new ExecutionCheckpointStore(database)
    .list(projectId, executionId)
    .filter(({ type }) => type === "agent.message");
  expect(messages).toHaveLength(1);
  const message = messages[0]?.payload["message"];
  expect(typeof message).toBe("string");
  return JSON.parse(message as string) as AgentObservation;
}

function readRemoteArtifact(
  fixture: RealGitRepositoryFixture,
  commit: string,
  path: string,
): string {
  return execFileSync("git", ["--git-dir", fixture.remoteRoot, "show", `${commit}:${path}`], {
    encoding: "utf8",
  });
}

function expectProjectSurfaceIsolated(
  surface: string,
  projectId: string,
  otherProjectId: string,
  otherBinding: string,
  executablePath: string,
  secret: string,
  otherWorkspace: string,
): void {
  expect(surface).toContain(projectId);
  expect(surface).not.toContain(otherProjectId);
  expect(surface).not.toContain(otherBinding);
  expect(surface).not.toContain(executablePath);
  expect(surface).not.toContain(secret);
  expect(surface).not.toContain(otherWorkspace);
}

function projectDatabaseSurface(database: Database.Database, projectId: string): string {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return tables
    .flatMap(({ name }) => {
      const identifier = quoteIdentifier(name);
      const columns = database.prepare(`PRAGMA table_info(${identifier})`).all() as {
        name: string;
      }[];
      if (!columns.some(({ name: column }) => column === "project_id")) return [];
      return database
        .prepare(`SELECT * FROM ${identifier} WHERE project_id = ?`)
        .all(projectId)
        .map((row: unknown) => JSON.stringify(row));
    })
    .join("\n");
}

function databaseText(database: Database.Database): string {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return tables
    .flatMap(({ name }) => {
      const identifier = quoteIdentifier(name);
      return database
        .prepare(`SELECT * FROM ${identifier}`)
        .all()
        .map((row: unknown) => JSON.stringify(row));
    })
    .join("\n");
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function seedGitHubConnection(dataRoot: string): void {
  const database = new Database(join(dataRoot, "jarvis.sqlite"));
  new ConnectionDescriptorStore(database).upsert({
    id: "connection/github-work-items",
    provider: "github",
    accountLabel: "Work Items",
    capabilities: ["work-items.read"],
    status: "available",
    secretRef: "gh://WorkItems",
  });
  database.close();
}

function seedCodexRuntime(dataRoot: string, executablePath: string): void {
  const database = new Database(join(dataRoot, "jarvis.sqlite"));
  const descriptor: RuntimeDescriptor = {
    id: CODEX_RUNTIME_REF,
    provider: "codex",
    displayName: "Codex — default",
    executablePath,
    version: "0.153.4",
    capabilities: ["agent.execute"],
    status: "available",
  };
  new RuntimeDescriptorStore(database).upsert(descriptor);
  database.close();
}

function writeFakeCodex(path: string): void {
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.153.4\\n");
  process.exit(0);
}
if (process.argv.includes("login") && process.argv.includes("status")) {
  process.stderr.write("Logged in using ChatGPT\\n");
  process.exit(0);
}
delete process.env.__CF_USER_TEXT_ENCODING;
const observation = { cwd: process.cwd(), environment: process.env };
fs.writeFileSync("codex-runtime-observation.json", JSON.stringify(observation));
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ type: "item.completed", item: { type: "file_change", id: "isolation-change", changes: [{ path: "codex-runtime-observation.json" }] } });
emit({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(observation) } });
emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
`,
    "utf8",
  );
  chmodSync(path, 0o755);
}
