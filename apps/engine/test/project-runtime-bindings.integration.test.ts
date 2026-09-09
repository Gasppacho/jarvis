import { readFileSync, rmSync } from "node:fs";
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
      `/v1/projects/${first}/binding-candidates`,
    );
    expect(choices.slots.find((slot) => slot.slotId === "agentRuntime")).toMatchObject({
      candidates: expect.arrayContaining([
        expect.objectContaining({ ref: "runtime/codex-default" }),
        expect.objectContaining({ ref: "runtime/fake-test" }),
      ]),
    });

    await replaceBinding(engine, first, "/private/fake/codex", "runtime/codex-default");
    await replaceBinding(engine, second, "/private/fake/fake", "runtime/fake-test");
    expect((await json<BindingsBody>(engine, `/v1/projects/${first}/bindings`)).slots).toEqual({
      agentRuntime: { kind: "runtime", ref: "runtime/codex-default" },
    });
    expect((await json<BindingsBody>(engine, `/v1/projects/${second}/bindings`)).slots).toEqual({
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
      `/v1/projects/${first}/binding-candidates`,
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
      `/v1/projects/${first}/validation-report`,
      "POST",
    );
    expect(report.valid).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "project.capability-unresolved" }),
    );

    const missing = await replaceBindingResponse(engine, second, "runtime/absent");
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe(
      "project.bindings-invalid",
    );
  });
});

async function createProject(engine: Harness): Promise<string> {
  const repositoryPath = makeNodeRepositoryFixture();
  projectRepositories.push(repositoryPath);
  const response = await engine.call("/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryPath, portableConfig: portableConfiguration() }),
  });
  const body = (await response.json()) as { id?: string; error?: unknown };
  expect(response.status, JSON.stringify(body)).toBe(201);
  return body.id!;
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
  configuration["modules"] = [automation];
  return configuration;
}

function seedRuntime(dataRoot: string, descriptor: RuntimeDescriptor): void {
  const database = new Database(join(dataRoot, "jarvis.sqlite"));
  new RuntimeDescriptorStore(database).upsert(descriptor);
  database.close();
}
