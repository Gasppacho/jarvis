import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { explain, localApiValidator } from "./contract.js";
import { startEngine, type Harness } from "./harness.js";
import { makeNodeRepositoryFixture } from "./repository-fixture.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("project composition review", () => {
  const engines: Harness[] = [];
  const repositories: string[] = [];

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
    for (const root of repositories.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function setup() {
    const engine = await startEngine();
    engines.push(engine);
    const repositoryPath = makeNodeRepositoryFixture();
    repositories.push(repositoryPath);
    const portableConfig = parseYaml(
      readFileSync(join(REPO_ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
    ) as Record<string, unknown>;
    const imported = await engine.call("/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryPath, portableConfig }),
    });
    expect(imported.status).toBe(201);
    return {
      engine,
      project: (await imported.json()) as {
        id: string;
        portableConfig: Record<string, unknown>;
      },
    };
  }

  it("saves and reopens a structurally complete but composition-incomplete Draft", async () => {
    const engine = await startEngine();
    engines.push(engine);
    const repositoryPath = makeNodeRepositoryFixture();
    repositories.push(repositoryPath);
    const importedResponse = await engine.call("/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryPath }),
    });
    const imported = (await importedResponse.json()) as {
      id: string;
      portableConfig: Record<string, unknown>;
    };

    const saved = await engine.call(`/v1/projects/${imported.id}/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portableConfig: imported.portableConfig, writeToRepository: false }),
    });
    const savedBody = await saved.json();
    expect(saved.status, JSON.stringify(savedBody)).toBe(200);
    expect(savedBody).toMatchObject({
      status: "draft",
      moduleCount: 0,
      portableConfig: imported.portableConfig,
    });
    expect(await (await engine.call(`/v1/projects/${imported.id}`)).json()).toMatchObject({
      portableConfig: imported.portableConfig,
    });
  });

  it("summarizes saved readiness from Engine-owned composition data without persisting review state", async () => {
    const { engine, project } = await setup();

    const response = await engine.call(`/v1/projects/${project.id}/composition-review`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const review = (await response.json()) as {
      apiVersion: string;
      kind: string;
      projectId: string;
      readyToValidate: boolean;
      composition: { moduleInstances: unknown[]; choices: unknown[] };
      validation: { valid: boolean; findings: Array<{ code: string }> };
      resources: { slots: unknown[] };
    };
    const validateReview = localApiValidator("ProjectCompositionReviewV1");
    expect(validateReview(review), explain(validateReview)).toBe(true);
    expect(review).toMatchObject({
      apiVersion: "jarvis.dev/project-composition-review/v1",
      kind: "ProjectCompositionReview",
      projectId: project.id,
      readyToValidate: false,
      composition: { moduleInstances: expect.any(Array), choices: expect.any(Array) },
      validation: { valid: false, findings: expect.any(Array) },
      resources: { slots: expect.any(Array) },
    });
    expect(review.readyToValidate).toBe(review.validation.valid);
    expect(review.validation.findings.map(({ code }) => code)).toContain("project.binding-missing");
    expect(JSON.stringify(review)).not.toMatch(/reviewState|eventGraph/);

    const reopened = (await (await engine.call(`/v1/projects/${project.id}`)).json()) as {
      portableConfig: Record<string, unknown>;
    };
    expect(reopened.portableConfig).toEqual(project.portableConfig);
  });

  it("previews orphaned and ambiguous repairs without replacing the saved Draft", async () => {
    const { engine, project } = await setup();
    const proposed = structuredClone(project.portableConfig);
    const modules = proposed["modules"] as Array<Record<string, unknown>>;
    const github = modules.find((module) => module["moduleId"] === "jarvis.module.github");
    expect(github).toBeDefined();
    modules.push({ ...structuredClone(github), instanceId: "github-secondary" });

    const response = await engine.call(`/v1/projects/${project.id}/composition-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portableConfig: proposed }),
    });
    expect(response.status).toBe(200);
    const review = (await response.json()) as {
      readyToValidate: boolean;
      validation: { findings: Array<{ code: string }> };
      composition: { choices: Array<{ routing: { status: string } }> };
    };
    expect(review.readyToValidate).toBe(false);
    expect(review.validation.findings.map(({ code }) => code)).toContain(
      "project.request-ambiguous",
    );
    expect(review.composition.choices.some(({ routing }) => routing.status === "ambiguous")).toBe(
      true,
    );

    const reopened = (await (await engine.call(`/v1/projects/${project.id}`)).json()) as {
      portableConfig: Record<string, unknown>;
    };
    expect(reopened.portableConfig).toEqual(project.portableConfig);
  });
});
