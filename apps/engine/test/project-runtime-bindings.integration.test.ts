import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { RuntimeDescriptor } from "../../../packages/agent-runtime/src/index.js";
import { RuntimeDescriptorStore } from "../src/runtimes/registry.js";
import { startEngine, type Harness } from "./harness.js";
import { makeNodeRepositoryFixture } from "./repository-fixture.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const projectRepositories: string[] = [];

interface ResourceChoicesBody {
  readonly agentRuntimes?: {
    readonly required: boolean;
    readonly items: readonly {
      readonly ref: string;
      readonly displayName: string;
      readonly version: string | null;
      readonly bound: boolean;
    }[];
    readonly readiness: { readonly status: string };
  };
  readonly slots: readonly {
    readonly slotId: string;
    readonly candidates: readonly unknown[];
    readonly ineligibleGrantedResources?: readonly unknown[];
  }[];
}

interface BindingsBody {
  readonly slots: Readonly<Record<string, unknown>>;
}

interface ValidationBody {
  readonly valid: boolean;
  readonly findings: readonly unknown[];
}

describe("project runtime bindings", () => {
  const engines: Harness[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
    for (const path of [...projectRepositories.splice(0), ...roots.splice(0)]) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("records an explicitly approved local profile and checks only the selected project", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "jarvis-runtime-ready-"));
    roots.push(dataRoot);
    const executable = join(dataRoot, "controlled-codex");
    const observation = join(dataRoot, "probes.jsonl");
    writeFileSync(
      executable,
      `#!${process.execPath}
const fs = require("node:fs");
// macOS inserts this runtime-owned variable after exec (same fixture policy as runtime-isolation).
delete process.env.__CF_USER_TEXT_ENCODING;
fs.appendFileSync(${JSON.stringify(observation)}, JSON.stringify({args: process.argv.slice(2), environment: process.env}) + "\\n");
if (process.argv[2] === "--version") console.log("codex-cli 0.153.4");
else if (process.argv[2] === "login") console.log(process.env.PATH && process.env.HOME ? "Logged in using ChatGPT" : "Not logged in");
else process.exit(99);
`,
    );
    chmodSync(executable, 0o755);
    const engine = await startEngine({
      dataRoot,
      env: { JARVIS_UNUSED: "not-granted", JARVIS_PRIVATE_TOKEN: "do-not-expose" },
    });
    engines.push(engine);
    seedRuntime(dataRoot, {
      id: "runtime/codex-default",
      provider: "codex",
      displayName: "Codex — personal",
      executablePath: executable,
      version: "0.153.4",
      capabilities: ["agent.execute"],
      status: "available",
    });
    const first = await createProject(engine);
    const second = await createProject(engine);
    const before = await json<unknown>(engine, `/v1/projects/${first.id}`);
    const portableFile = join(first.repositoryPath, ".jarvis/project.yaml");
    mkdirSync(join(first.repositoryPath, ".jarvis"), { recursive: true });
    writeFileSync(portableFile, "# portable sentinel\n");
    const select = await engine.call(`/v1/projects/${first.id}/runtime-binding`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "runtime/codex-default", approveEnvironment: true }),
    });
    expect(select.status).toBe(200);
    const checked = await json<{
      readiness: { status: string; checkedAt: string };
      items: unknown[];
    }>(engine, `/v1/projects/${first.id}/runtime-readiness`, "POST");
    expect(checked.readiness).toMatchObject({ status: "ready", checkedAt: expect.any(String) });
    const bindings = await json<BindingsBody>(engine, `/v1/projects/${first.id}/bindings`);
    expect(bindings.slots).toMatchObject({
      agentRuntime: {
        ref: "runtime/codex-default",
        environment: { PATH: expect.any(String), HOME: expect.any(String) },
      },
    });
    expect((await json<BindingsBody>(engine, `/v1/projects/${second.id}/bindings`)).slots).toEqual(
      {},
    );
    expect(await json<unknown>(engine, `/v1/projects/${first.id}`)).toEqual(before);
    expect(readFileSync(portableFile, "utf8")).toBe("# portable sentinel\n");
    const probes = readFileSync(observation, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; environment: Record<string, string> });
    expect(probes.map((probe) => probe.args)).toEqual([["--version"], ["login", "status"]]);
    for (const probe of probes) {
      expect(Object.keys(probe.environment).sort()).toEqual(["HOME", "PATH"]);
      expect(probe.environment).not.toHaveProperty("JARVIS_UNUSED");
      expect(probe.environment).not.toHaveProperty("JARVIS_PRIVATE_TOKEN");
    }
    expect(JSON.stringify(checked)).not.toContain(dataRoot);
    expect(JSON.stringify(checked)).not.toContain("do-not-expose");
    const reopened = await json<ResourceChoicesBody>(
      engine,
      `/v1/projects/${first.id}/binding-candidates`,
    );
    expect(reopened.agentRuntimes).toMatchObject({
      items: [expect.objectContaining({ bound: true })],
      readiness: { status: "unchecked" },
    });
  });

  it("distinguishes absence, permission, authentication, incompatible output and bounded probe failure", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "jarvis-runtime-errors-"));
    roots.push(dataRoot);
    const executable = join(dataRoot, "codex-controlled");
    const script = (version: string, login: string, hang = false) => {
      writeFileSync(
        executable,
        `#!${process.execPath}
if (process.argv[2] === "--version") ${hang ? "setTimeout(() => {}, 60000)" : `console.log(${JSON.stringify(version)})`};
else if (process.argv[2] === "login") console.log(${JSON.stringify(login)});
else { require("node:fs").writeFileSync(${JSON.stringify(join(dataRoot, "unexpected-start"))}, "unexpected"); process.exit(99); }
`,
      );
      chmodSync(executable, 0o755);
    };
    script("codex-cli 0.153.4", "Logged in using ChatGPT");
    const engine = await startEngine({ dataRoot });
    engines.push(engine);
    seedRuntime(dataRoot, {
      id: "runtime/codex-default",
      provider: "codex",
      displayName: "Codex test",
      executablePath: executable,
      version: "0.153.4",
      capabilities: ["agent.execute"],
      status: "available",
    });
    const project = await createProject(engine);
    const choose = (body: unknown) =>
      engine.call(`/v1/projects/${project.id}/runtime-binding`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await choose({ ref: "runtime/codex-default", approveEnvironment: false })).status).toBe(
      400,
    );
    expect(
      (
        await choose({
          ref: "runtime/codex-default",
          approveEnvironment: true,
          environment: { HOME: "/other/project" },
        })
      ).status,
    ).toBe(400);
    expect((await choose({ ref: "runtime/codex-default", approveEnvironment: true })).status).toBe(
      200,
    );
    const check = () =>
      json<{ readiness: { status: string; detail: string } }>(
        engine,
        `/v1/projects/${project.id}/runtime-readiness`,
        "POST",
      );
    expect((await check()).readiness.status).toBe("ready");
    chmodSync(executable, 0o644);
    expect((await check()).readiness.status).toBe("access-denied");
    rmSync(executable);
    expect((await check()).readiness.status).toBe("absent");
    script("unsupported-version /private/secret-token", "Logged in using ChatGPT");
    const incompatible = await check();
    expect(incompatible.readiness.status).toBe("incompatible");
    expect(JSON.stringify(incompatible)).not.toContain("secret-token");
    script("codex-cli 0.153.4", "Not logged in");
    expect((await check()).readiness.status).toBe("access-denied");
    script("codex-cli 0.153.4", "Logged in using ChatGPT", true);
    const started = Date.now();
    expect((await check()).readiness.status).toBe("engine-error");
    expect(Date.now() - started).toBeLessThan(5000);
    script("codex-cli 0.153.4", "Logged in using ChatGPT");
    seedRuntime(dataRoot, {
      id: "runtime/codex-default",
      provider: "codex",
      displayName: "Codex limité",
      executablePath: executable,
      version: "0.153.4",
      capabilities: [],
      status: "available",
    });
    expect((await check()).readiness).toMatchObject({
      status: "incompatible",
      detail: expect.stringContaining("agent.execute"),
    });
    seedRuntime(dataRoot, {
      id: "runtime/codex-compatible",
      provider: "codex",
      displayName: "Codex compatible",
      executablePath: executable,
      version: "0.154.0",
      capabilities: ["agent.execute"],
      status: "available",
    });
    const alternatives = await json<ResourceChoicesBody>(
      engine,
      `/v1/projects/${project.id}/binding-candidates`,
    );
    expect(alternatives.agentRuntimes?.items).toEqual([
      expect.objectContaining({
        ref: "runtime/codex-compatible",
        displayName: "Codex compatible",
        version: "0.154.0",
        selectable: true,
        bound: false,
      }),
      expect.objectContaining({
        ref: "runtime/codex-default",
        displayName: "Codex limité",
        selectable: false,
        bound: true,
      }),
    ]);
    expect(existsSync(join(dataRoot, "unexpected-start"))).toBe(false);
    expect(
      (await json<{ items: unknown[] }>(engine, `/v1/projects/${project.id}/executions`)).items,
    ).toEqual([]);
  });

  it("does not require an unused optional runtime slot", async () => {
    const engine = await startEngine();
    engines.push(engine);
    const project = await createProject(engine);
    const configuration = portableConfiguration();
    configuration["modules"] = (configuration["modules"] as { instanceId: string }[]).filter(
      (instance) => instance.instanceId !== "development",
    );
    configuration["slots"] = { agentRuntime: { requires: "agent.execute", optional: true } };
    const save = await engine.call(`/v1/projects/${project.id}/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portableConfig: configuration, writeToRepository: false }),
    });
    expect(save.status).toBe(200);
    expect(
      (await json<ResourceChoicesBody>(engine, `/v1/projects/${project.id}/binding-candidates`))
        .agentRuntimes?.required,
    ).toBe(false);
  });

  it("offers registry runtimes per project and rejects a stale unavailable binding", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "jarvis-runtime-bindings-"));
    roots.push(dataRoot);
    const engine = await startEngine({ dataRoot });
    engines.push(engine);
    seedRuntime(dataRoot, {
      id: "runtime/codex-default",
      provider: "codex",
      displayName: "Codex — default",
      executablePath: "/private/fake/codex",
      version: "0.153.4",
      capabilities: ["agent.execute"],
      status: "available",
    });

    const first = await createProject(engine);
    const second = await createProject(engine);
    const choices = await json<ResourceChoicesBody>(
      engine,
      `/v1/projects/${first.id}/binding-candidates`,
    );
    expect(choices.agentRuntimes).toMatchObject({
      required: true,
      items: [
        expect.objectContaining({
          ref: "runtime/codex-default",
          displayName: "Codex — default",
          version: "0.153.4",
          bound: false,
        }),
      ],
      readiness: { status: "unchecked" },
    });
    expect(choices.slots.find((slot) => slot.slotId === "agentRuntime")).toMatchObject({
      candidates: expect.arrayContaining([
        expect.objectContaining({ ref: "runtime/codex-default" }),
        expect.objectContaining({ ref: "runtime/fake-test" }),
      ]),
    });

    await replaceBinding(engine, first.id, first.repositoryPath, "runtime/codex-default");
    await replaceBinding(engine, second.id, second.repositoryPath, "runtime/fake-test");
    expect((await json<BindingsBody>(engine, `/v1/projects/${first.id}/bindings`)).slots).toEqual({
      agentRuntime: { kind: "runtime", ref: "runtime/codex-default" },
    });
    expect((await json<BindingsBody>(engine, `/v1/projects/${second.id}/bindings`)).slots).toEqual({
      agentRuntime: { kind: "runtime", ref: "runtime/fake-test" },
    });

    const database = new Database(join(dataRoot, "jarvis.sqlite"));
    new RuntimeDescriptorStore(database).upsert({
      id: "runtime/codex-default",
      provider: "codex",
      displayName: "Codex — default",
      executablePath: "/private/fake/codex",
      version: "0.153.4",
      capabilities: ["agent.execute"],
      status: "unauthenticated",
    });
    database.close();

    const unavailable = await json<ResourceChoicesBody>(
      engine,
      `/v1/projects/${first.id}/binding-candidates`,
    );
    const agentRuntime = unavailable.slots.find((slot) => slot.slotId === "agentRuntime");
    expect(agentRuntime).toMatchObject({
      ineligibleGrantedResources: [
        expect.objectContaining({ reason: expect.stringContaining('"unauthenticated"') }),
      ],
    });
    expect(JSON.stringify(agentRuntime)).not.toContain("/private/fake/codex");
    const report = await json<ValidationBody>(
      engine,
      `/v1/projects/${first.id}/validation-report`,
      "POST",
    );
    expect(report.valid).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "project.capability-unresolved" }),
    );

    const missing = await replaceBindingResponse(engine, second.id, "runtime/absent");
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      "project.bindings-invalid",
    );
  });
});

async function createProject(engine: Harness): Promise<{ id: string; repositoryPath: string }> {
  const repositoryPath = realpathSync(makeNodeRepositoryFixture());
  projectRepositories.push(repositoryPath);
  const response = await engine.call("/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryPath, portableConfig: portableConfiguration() }),
  });
  const body = (await response.json()) as { id?: string; error?: unknown };
  expect(response.status, JSON.stringify(body)).toBe(201);
  return { id: body.id!, repositoryPath };
}

async function replaceBinding(
  engine: Harness,
  projectId: string,
  path: string,
  ref: string,
): Promise<void> {
  const response = await replaceBindingResponse(engine, projectId, ref, path);
  expect(response.status).toBe(200);
}

function replaceBindingResponse(
  engine: Harness,
  projectId: string,
  ref: string,
  path = "/private/fake/project",
): Promise<Response> {
  return engine.call(`/v1/projects/${projectId}/bindings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      apiVersion: "jarvis.dev/project-bindings/v1",
      kind: "ProjectBindings",
      projectId,
      repositories: { main: { path, bookmarkRef: null } },
      slots: { agentRuntime: { kind: "runtime", ref } },
    }),
  });
}

async function json<T>(engine: Harness, path: string, method = "GET"): Promise<T> {
  const response = await engine.call(path, { method });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

function portableConfiguration(): Record<string, unknown> {
  const configuration = parseYaml(
    readFileSync(join(ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
  ) as Record<string, unknown>;
  const modules = configuration["modules"] as Record<string, unknown>[];
  const automation = modules.find(
    (module) => module["moduleId"] === "jarvis.module.automation-rules",
  );
  if (automation === undefined) throw new Error("automation-rules fixture is missing");
  configuration["slots"] = { agentRuntime: { requires: "agent.execute" } };
  configuration["modules"] = [
    automation,
    {
      instanceId: "development",
      moduleId: "jarvis.module.development",
      enabled: true,
      runtimeSlot: "agentRuntime",
      bindings: { repository: "main" },
      configuration: {
        preparation: "none",
        validationOrder: ["test"],
        maxRepairCycles: 0,
        retainWorkspaceOnSuccess: false,
        timeoutMs: 300000,
        outputLimitBytes: 1048576,
        environmentAllowlist: ["PATH", "HOME"],
      },
    },
  ];
  return configuration;
}

function seedRuntime(dataRoot: string, descriptor: RuntimeDescriptor): void {
  const database = new Database(join(dataRoot, "jarvis.sqlite"));
  new RuntimeDescriptorStore(database).upsert(descriptor);
  database.close();
}
