import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { explain, localApiValidator } from "./contract.js";
import { startEngine, type Harness } from "./harness.js";
import { makeNodeRepositoryFixture } from "./repository-fixture.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("project composition choices", () => {
  const engines: Harness[] = [];
  const repositories: string[] = [];
  const runtimeRoots: string[] = [];
  let validatePreview: ReturnType<typeof localApiValidator>;

  beforeAll(() => {
    validatePreview = localApiValidator("ProjectCompositionChoicesV1");
  });

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
    for (const root of [...repositories.splice(0), ...runtimeRoots.splice(0)]) {
      rmSync(root, { recursive: true, force: true });
    }
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
    const project = (await imported.json()) as {
      id: string;
      portableConfig: Record<string, unknown>;
    };
    return { engine, project };
  }

  const preview = (engine: Harness, projectId: string, portableConfig?: Record<string, unknown>) =>
    engine.call(`/v1/projects/${projectId}/composition-choices`, {
      method: "POST",
      ...(portableConfig === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ portableConfig }),
          }),
    });

  it("returns no choices for a fresh discovered Project draft", async () => {
    const engine = await startEngine();
    engines.push(engine);
    const repositoryPath = makeNodeRepositoryFixture();
    repositories.push(repositoryPath);
    const imported = await engine.call("/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryPath }),
    });
    const project = (await imported.json()) as { id: string };

    const response = await preview(engine, project.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      apiVersion: "jarvis.dev/project-composition-choices/v1",
      kind: "ProjectCompositionChoices",
      projectId: project.id,
      choices: [],
    });
  });

  it("previews deterministic contract-owned choices for the canonical composition without mutation", async () => {
    const { engine, project } = await setup();
    const before = await (await engine.call(`/v1/projects/${project.id}`)).json();

    const response = await preview(engine, project.id);
    expect(response.status, `${await response.clone().text()}\n${engine.stderr()}`).toBe(200);
    const body = (await response.json()) as {
      choices: Array<Record<string, unknown>>;
    };
    expect(validatePreview(body), explain(validatePreview)).toBe(true);
    const choiceKeys = body.choices.map(
      (choice) =>
        `${String(choice["type"])}.v${String(choice["version"])}.${String(choice["kind"])}`,
    );
    expect(choiceKeys).toEqual([...choiceKeys].sort());
    expect(body.choices).toContainEqual(
      expect.objectContaining({
        label: "Work item tag added",
        type: "scm.work-item.tag-added",
        version: 1,
        kind: "fact",
        description: "A source-control work item received a tag.",
        payloadSchema: expect.objectContaining({ type: "object" }),
        producers: [{ instanceId: "github", moduleId: "jarvis.module.github" }],
        consumers: [
          {
            instanceId: "automation-rules",
            moduleId: "jarvis.module.automation-rules",
            compatibility: "compatible",
          },
        ],
        routing: {
          status: "broadcast",
          explanation: "Facts may be delivered to zero or many compatible consumers (1 available).",
        },
      }),
    );
    expect(body.choices).toContainEqual(
      expect.objectContaining({
        label: "Implementation requested",
        type: "development.implementation.requested",
        version: 1,
        kind: "request",
        producers: [{ instanceId: "automation-rules", moduleId: "jarvis.module.automation-rules" }],
        consumers: [
          {
            instanceId: "development",
            moduleId: "jarvis.module.development",
            compatibility: "compatible",
          },
        ],
        routing: {
          status: "resolved",
          selectedConsumer: {
            instanceId: "development",
            moduleId: "jarvis.module.development",
          },
          explanation: "The Request resolves to exactly one compatible consumer.",
        },
      }),
    );
    expect(await (await preview(engine, project.id)).json()).toEqual(body);
    expect(await (await engine.call(`/v1/projects/${project.id}`)).json()).toEqual(before);
  });

  it("previews proposed add, remove, enable and package changes without saving the draft", async () => {
    const { engine, project } = await setup();
    const before = await (await engine.call(`/v1/projects/${project.id}`)).json();
    const proposed = structuredClone(project.portableConfig);
    const modules = proposed["modules"] as Array<Record<string, unknown>>;
    const github = modules.find((module) => module["instanceId"] === "github")!;
    github["enabled"] = false;
    modules.splice(
      modules.findIndex((module) => module["instanceId"] === "development"),
      1,
    );

    const disabledResponse = await preview(engine, project.id, proposed);
    expect(
      disabledResponse.status,
      `${await disabledResponse.clone().text()}\n${engine.stderr()}`,
    ).toBe(200);
    const disabled = (await disabledResponse.json()) as {
      choices: Array<{ type: string; routing: { status: string } }>;
    };
    expect(disabled.choices.map((choice) => choice.type)).toEqual([
      "development.implementation.requested",
      "scm.work-item.tag-added",
    ]);
    expect(
      disabled.choices.find((choice) => choice.type === "development.implementation.requested")
        ?.routing.status,
    ).toBe("orphaned");

    const originalDevelopment = (
      project.portableConfig["modules"] as Array<Record<string, unknown>>
    ).find((module) => module["instanceId"] === "development")!;
    modules.push({ ...structuredClone(originalDevelopment), instanceId: "development-2" });

    github["enabled"] = true;
    github["moduleId"] = "jarvis.module.change-request-review";
    delete github["configuration"];
    const changed = (await (await preview(engine, project.id, proposed)).json()) as {
      choices: Array<{ type: string }>;
    };
    expect(changed.choices.map((choice) => choice.type)).toEqual([
      "development.implementation.completed",
      "development.implementation.failed",
      "development.implementation.requested",
      "scm.change-request.created",
      "scm.change-request.creation-requested",
      "scm.work-item.tag-added",
    ]);
    expect(await (await engine.call(`/v1/projects/${project.id}`)).json()).toEqual(before);
  });

  it("explains an untargeted Request with multiple compatible consumers as ambiguous", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "jarvis-composition-choices-"));
    runtimeRoots.push(fixtureRoot);
    const runtimeRoot = join(fixtureRoot, "engine");
    cpSync(join(REPO_ROOT, "dist/engine"), runtimeRoot, { recursive: true });
    const manifestPath = join(runtimeRoot, "modules/automation-rules/module.manifest.yaml");
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, "utf8")
        .replace("      targeting:\n        configurationPath: /rules/*/emit\n", "")
        .replace(
          "configuration:\n  schemaRef: contracts/module-config/automation-rules.v1.schema.json\n",
          "",
        ),
      "utf8",
    );
    const engine = await startEngine({ enginePath: join(runtimeRoot, "engine.bundle.mjs") });
    engines.push(engine);
    const repositoryPath = makeNodeRepositoryFixture();
    repositories.push(repositoryPath);
    const portableConfig = parseYaml(
      readFileSync(join(REPO_ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
    ) as Record<string, unknown>;
    const originalModules = portableConfig["modules"] as Array<Record<string, unknown>>;
    const automation = structuredClone(
      originalModules.find((module) => module["instanceId"] === "automation-rules")!,
    );
    delete automation["configuration"];
    const development = originalModules.find((module) => module["instanceId"] === "development")!;
    portableConfig["modules"] = [
      automation,
      structuredClone(development),
      { ...structuredClone(development), instanceId: "development-2" },
    ];
    const imported = await engine.call("/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryPath, portableConfig }),
    });
    expect(imported.status, await imported.clone().text()).toBe(201);
    const project = (await imported.json()) as { id: string };

    const response = await preview(engine, project.id);
    const body = (await response.json()) as {
      choices: Array<{ type: string; routing: { status: string; explanation: string } }>;
    };
    expect(
      body.choices.find((choice) => choice.type === "development.implementation.requested")
        ?.routing,
    ).toEqual({
      status: "ambiguous",
      explanation: "The Request has 2 compatible consumers; select exactly one.",
    });
  });
});
