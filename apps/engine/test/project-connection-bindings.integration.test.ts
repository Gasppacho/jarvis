import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const engines: Harness[] = [];
const roots: string[] = [];
const repositories: string[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  for (const path of [...repositories.splice(0), ...roots.splice(0)]) {
    rmSync(path, { recursive: true, force: true });
  }
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
): Promise<{ id: string; repositoryPath: string }> {
  const configuration = portableConfiguration(id);
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
