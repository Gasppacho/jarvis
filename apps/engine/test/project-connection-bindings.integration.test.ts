import Database from "better-sqlite3";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConnectionDescriptorStore,
  type ConnectionDescriptor,
  type ConnectionStatus,
} from "../src/connections/registry.js";
import type { ProjectBindings } from "../../../packages/project-runtime/src/project-types.js";
import { startEngine, type Harness } from "./harness.js";
import { makeNodeRepositoryFixture } from "./repository-fixture.js";
import { SystemClock } from "../../../packages/kernel/src/clock.js";
import { GitHubCliCredentialResolver } from "../../../packages/modules/github/src/index.js";
import { loadBundledModuleHost } from "../src/modules/bundled-module-registry.js";
import { ProjectModuleCapabilityResolver } from "../src/executions/capabilities.js";
import { LocalAgentRuntimeRegistry } from "../src/projects/resource-grants.js";
import { ProjectStore } from "../src/projects/store.js";
import { RuntimeRegistry } from "../src/runtimes/registry.js";
import { ConnectionRegistry } from "../src/connections/registry.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TEST_BUNDLE = fileURLToPath(
  new URL("../../../dist/engine/engine.test-bundle.mjs", import.meta.url),
);
const engines: Harness[] = [];
const roots: string[] = [];
const repositories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  for (const path of [...repositories.splice(0), ...roots.splice(0)]) {
    rmSync(path, { recursive: true, force: true });
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("project connection bindings", () => {
  it("offers available connections and discloses granted ineligible statuses", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-connection-candidates-"));
    roots.push(dataRoot);
    const engine = await start(dataRoot);
    seedConnection(dataRoot, "connection/github-available");
    seedConnection(dataRoot, "connection/github-unauthenticated", "unauthenticated");
    seedConnection(dataRoot, "connection/github-missing-capability", "available", ["github.api"]);
    const project = await createProject(engine, "project-candidates");

    const response = await engine.call(`/v1/projects/${project.id}/binding-candidates`);
    expect(response.status).toBe(200);
    const choices = (await response.json()) as {
      slots: {
        slotId: string;
        candidates: { ref: string }[];
        ineligibleGrantedResources?: { candidate: { ref: string }; reason: string }[];
      }[];
    };
    const sourceControl = choices.slots.find((slot) => slot.slotId === "sourceControl");
    expect(sourceControl?.candidates).toEqual([
      expect.objectContaining({ ref: "connection/github-available" }),
    ]);
    expect(sourceControl?.ineligibleGrantedResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidate: expect.objectContaining({ ref: "connection/github-unauthenticated" }),
          reason: expect.stringContaining('status is "unauthenticated"'),
        }),
        expect.objectContaining({
          candidate: expect.objectContaining({ ref: "connection/github-missing-capability" }),
          reason: expect.stringContaining("scm.change-request.manage"),
        }),
      ]),
    );
  });

  it("isolates concurrent bindings, keeps them through restart, and replaces one slot", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-connection-bindings-"));
    roots.push(dataRoot);
    const connectionA = "connection/github-a";
    const connectionB = "connection/github-b";
    const replacement = "connection/github-replacement";
    const engine = await start(dataRoot);
    seedConnection(dataRoot, connectionA);
    seedConnection(dataRoot, connectionB);
    seedConnection(dataRoot, replacement);

    const projectA = await createProject(engine, "project-a");
    const projectB = await createProject(engine, "project-b");
    const configFiles = [
      readFileSync(join(projectA.repositoryPath, ".jarvis", "project.yaml"), "utf8"),
      readFileSync(join(projectB.repositoryPath, ".jarvis", "project.yaml"), "utf8"),
    ];

    const bound = await Promise.all([
      replaceConnectionBinding(engine, projectA.id, connectionA),
      replaceConnectionBinding(engine, projectB.id, connectionB),
    ]);
    expect(bound.map((response) => response.status)).toEqual([200, 200]);

    expect((await readBindings(engine, projectA.id)).slots).toEqual({
      sourceControl: { kind: "connection", ref: connectionA },
    });
    expect(JSON.stringify(await readBindings(engine, projectA.id))).not.toContain(connectionB);
    expect((await readBindings(engine, projectB.id)).slots).toEqual({
      sourceControl: { kind: "connection", ref: connectionB },
    });

    await stop(engine);
    const restarted = await start(dataRoot);
    expect((await readBindings(restarted, projectA.id)).slots).toEqual({
      sourceControl: { kind: "connection", ref: connectionA },
    });
    expect((await readBindings(restarted, projectB.id)).slots).toEqual({
      sourceControl: { kind: "connection", ref: connectionB },
    });

    const rewritten = await replaceConnectionBinding(restarted, projectA.id, replacement);
    expect(rewritten.status).toBe(200);
    const replaced = await readBindings(restarted, projectA.id);
    expect(replaced.slots).toEqual({
      sourceControl: { kind: "connection", ref: replacement },
    });
    expect(Object.keys(replaced.slots)).toEqual(["sourceControl"]);
    expect(JSON.stringify(replaced)).not.toContain(connectionA);

    for (const [index, project] of [projectA, projectB].entries()) {
      const configuration = readFileSync(
        join(project.repositoryPath, ".jarvis", "project.yaml"),
        "utf8",
      );
      expect(configuration).toBe(configFiles[index]);
      expect(configuration).not.toContain(connectionA);
      expect(configuration).not.toContain(connectionB);
      expect(configuration).not.toContain(replacement);
    }
  });

  it("rejects absent and non-available sourceControl connections", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-connection-bindings-invalid-"));
    roots.push(dataRoot);
    const unavailable = "connection/github-unavailable";
    const unauthenticated = "connection/github-unauthenticated";
    const engine = await start(dataRoot);
    seedConnection(dataRoot, unavailable, "unavailable");
    seedConnection(dataRoot, unauthenticated, "unauthenticated");
    const project = await createProject(engine, "project-invalid");

    for (const ref of ["connection/github-absent", unavailable, unauthenticated]) {
      const response = await replaceConnectionBinding(engine, project.id, ref);
      expect(response.status).toBe(400);
      expect((await response.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "project.bindings-invalid" },
      });
    }

    expect((await readBindings(engine, project.id)).slots).toEqual({});
  });

  it("proves project-scoped GitHub resolution and keeps credentials out of durable state", async () => {
    const credentialA = "ghs_project_a_sentinel";
    const credentialB = "ghs_project_b_sentinel";
    const fakeGhRoot = mkdtempSync(join(tmpdir(), "jarvis-gh-isolation-"));
    roots.push(fakeGhRoot);
    const fakeGh = join(fakeGhRoot, "gh");
    writeFileSync(
      fakeGh,
      `#!/bin/sh
case "$*" in
  *"--user AccountA"*) printf '%s\\n' '${credentialA}';;
  *"--user AccountB"*) printf '%s\\n' '${credentialB}';;
  *) exit 1;;
esac
`,
      "utf8",
    );
    chmodSync(fakeGh, 0o755);
    const requests: { path: string; account: "A" | "B" | "unknown" }[] = [];
    const github = createServer((request, response) => {
      const authorization = request.headers.authorization;
      const account =
        authorization === `Bearer ${credentialA}`
          ? "A"
          : authorization === `Bearer ${credentialB}`
            ? "B"
            : "unknown";
      requests.push({ path: request.url ?? "", account });
      response.writeHead(account === "unknown" ? 401 : 200, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify(
          account === "unknown" ? { message: "Bad credentials" } : { login: `Account${account}` },
        ),
      );
    });
    servers.push(github);
    const apiBaseUrl = await listen(github);
    const dataRoot = mkdtempSync(join(tmpdir(), "jarvis-connection-isolation-"));
    roots.push(dataRoot);
    const engine = await startEngine({
      dataRoot,
      enginePath: TEST_BUNDLE,
      env: { JARVIS_GH_EXECUTABLE: fakeGh, JARVIS_GITHUB_API_BASE_URL: apiBaseUrl },
    });
    engines.push(engine);
    const responses: string[] = [];
    const register = async (id: string, account: string): Promise<void> => {
      const response = await engine.call("/v1/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id,
          kind: "github",
          displayName: account,
          secretRef: `gh://${account}`,
        }),
      });
      responses.push(await response.clone().text());
      expect(response.status).toBe(201);
      const validated = await engine.call(`/v1/connections/${encodeURIComponent(id)}/validate`, {
        method: "POST",
      });
      responses.push(await validated.clone().text());
      expect(validated.status).toBe(200);
    };
    await register("connection/github-a", "AccountA");
    await register("connection/github-b", "AccountB");
    const projectA = await createProject(
      engine,
      "project-isolation-a",
      githubOnlyConfiguration("project-isolation-a"),
    );
    const projectB = await createProject(
      engine,
      "project-isolation-b",
      githubOnlyConfiguration("project-isolation-b"),
    );
    const projectWithoutBinding = await createProject(
      engine,
      "project-isolation-unbound",
      githubOnlyConfiguration("project-isolation-unbound"),
    );
    await bindGitHubProject(engine, projectA.id, "connection/github-a");
    await bindGitHubProject(engine, projectB.id, "connection/github-b");
    const reportA = await engine.call(`/v1/projects/${projectA.id}/validation-report`, {
      method: "POST",
    });
    const reportB = await engine.call(`/v1/projects/${projectB.id}/validation-report`, {
      method: "POST",
    });
    const reportABody = (await reportA.json()) as {
      valid: boolean;
      compositionFingerprint: string;
    };
    const reportBBody = (await reportB.json()) as {
      valid: boolean;
      compositionFingerprint: string;
    };
    expect(reportABody.valid, JSON.stringify(reportABody)).toBe(true);
    expect(reportBBody.valid, JSON.stringify(reportBBody)).toBe(true);
    await activate(engine, projectA.id, reportABody.compositionFingerprint);
    await activate(engine, projectB.id, reportBBody.compositionFingerprint);
    const stderr = engine.stderr();
    await engine.dispose();
    engines.splice(engines.indexOf(engine), 1);

    const database = new Database(join(dataRoot, "jarvis.sqlite"));
    const store = new ProjectStore(database, new SystemClock());
    const connections = new ConnectionRegistry(database);
    const runtimeRegistry = new RuntimeRegistry(database);
    const modules = loadBundledModuleHost(join(ROOT, "dist/engine"));
    const credentials = new GitHubCliCredentialResolver({
      cwd: process.cwd(),
      knownExecutablePaths: [fakeGh],
      allowShellProbe: false,
    });
    const resolver = new ProjectModuleCapabilityResolver(
      store,
      modules,
      new LocalAgentRuntimeRegistry(runtimeRegistry),
      undefined,
      connections,
      credentials,
      apiBaseUrl,
    );
    const capabilityA = resolver.resolve(projectA.id, "github", "jarvis.module.github");
    const capabilityB = resolver.resolve(projectB.id, "github", "jarvis.module.github");
    await expect(capabilityA.githubApi?.get("/user")).resolves.toMatchObject({ status: 200 });
    await expect(capabilityB.githubApi?.get("/user")).resolves.toMatchObject({ status: 200 });
    expect(() =>
      resolver.resolve(projectWithoutBinding.id, "github", "jarvis.module.github"),
    ).toThrow("sourceControl");
    database.close();

    expect(
      requests.filter((request) => request.path === "/user").map((request) => request.account),
    ).toEqual(["A", "B", "A", "B"]);
    expect(responses.join("\n")).not.toContain(credentialA);
    expect(responses.join("\n")).not.toContain(credentialB);
    expect(stderr).not.toContain(credentialA);
    expect(stderr).not.toContain(credentialB);
    const durable = readdirBytes(dataRoot);
    expect(durable).not.toContain(credentialA);
    expect(durable).not.toContain(credentialB);
    expect(durable).not.toContain("/Users/");
  });
});

async function start(dataRoot: string): Promise<Harness> {
  const engine = await startEngine({ dataRoot });
  engines.push(engine);
  return engine;
}

async function stop(engine: Harness): Promise<void> {
  await engine.dispose();
  engines.splice(engines.indexOf(engine), 1);
}

async function createProject(
  engine: Harness,
  id: string,
  configuration: Record<string, unknown> = portableConfiguration(id),
): Promise<{ id: string; repositoryPath: string }> {
  const repositoryPath = makeNodeRepositoryFixture({
    projectYaml: stringifyYaml(configuration),
  });
  repositories.push(repositoryPath);
  const response = await engine.call("/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryPath }),
  });
  const body = (await response.json()) as { id?: string; error?: unknown };
  expect(response.status, JSON.stringify(body)).toBe(201);
  expect(body.id).toBe(id);
  return { id: body.id!, repositoryPath };
}

async function readBindings(engine: Harness, projectId: string): Promise<ProjectBindings> {
  const response = await engine.call(`/v1/projects/${projectId}/bindings`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ProjectBindings;
}

async function replaceConnectionBinding(
  engine: Harness,
  projectId: string,
  ref: string,
): Promise<Response> {
  const current = await readBindings(engine, projectId);
  return engine.call(`/v1/projects/${projectId}/bindings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...current,
      slots: { ...current.slots, sourceControl: { kind: "connection", ref } },
    }),
  });
}

function portableConfiguration(id: string): Record<string, unknown> {
  const configuration = parseYaml(
    readFileSync(join(ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
  ) as Record<string, unknown>;
  configuration["metadata"] = { id, name: id };
  return configuration;
}

function githubOnlyConfiguration(id: string): Record<string, unknown> {
  const configuration = portableConfiguration(id);
  configuration["slots"] = {
    sourceControl: { requires: "scm.change-request.manage" },
    tickets: { requires: "work-items.read" },
  };
  configuration["modules"] = [
    {
      instanceId: "github",
      moduleId: "jarvis.module.github",
      enabled: true,
      bindings: { sourceControl: "sourceControl", tickets: "tickets" },
      configuration: {
        bootstrapLabelPolicy: "ignore-existing",
        pollIntervalSeconds: 60,
        repositories: ["main"],
      },
    },
  ];
  return configuration;
}

async function bindComplete(
  engine: Harness,
  projectId: string,
  connectionRef: string,
): Promise<void> {
  const current = await readBindings(engine, projectId);
  const response = await engine.call(`/v1/projects/${projectId}/bindings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...current,
      slots: {
        sourceControl: { kind: "connection", ref: connectionRef },
        tickets: { kind: "connection", ref: connectionRef },
        agentRuntime: { kind: "runtime", ref: "runtime/fake-test" },
      },
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function bindGitHubProject(
  engine: Harness,
  projectId: string,
  connectionRef: string,
): Promise<void> {
  const current = await readBindings(engine, projectId);
  const response = await engine.call(`/v1/projects/${projectId}/bindings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...current,
      slots: {
        sourceControl: { kind: "connection", ref: connectionRef },
        tickets: { kind: "connection", ref: connectionRef },
      },
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function activate(
  engine: Harness,
  projectId: string,
  compositionFingerprint: string,
): Promise<void> {
  const response = await engine.call(`/v1/projects/${projectId}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ compositionFingerprint }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

function readdirBytes(root: string): string {
  return readdirSync(root)
    .filter((name) => name.startsWith("jarvis.sqlite"))
    .map((name) => readFileSync(join(root, name)).toString("utf8"))
    .join("\n");
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("fake GitHub server did not expose a port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function seedConnection(
  dataRoot: string,
  id: string,
  status: ConnectionStatus = "available",
  capabilities = ["github.api", "scm.change-request.manage", "work-items.read"],
): void {
  const database = new Database(join(dataRoot, "jarvis.sqlite"));
  new ConnectionDescriptorStore(database).upsert({
    id,
    provider: "github",
    accountLabel: id,
    capabilities,
    status,
    secretRef: `gh://${id}`,
  } satisfies ConnectionDescriptor);
  database.close();
}
