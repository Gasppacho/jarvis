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
    expect(await response.json()).toEqual(
      expect.objectContaining({
        apiVersion: "jarvis.dev/project-composition-choices/v1",
        kind: "ProjectCompositionChoices",
        projectId: project.id,
        moduleInstances: [],
        choices: [],
      }),
    );
  });

  it("offers canonical starting points and human Module Instance choices without implicit local grants", async () => {
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

    const fresh = (await (await preview(engine, project.id)).json()) as {
      startingPoints: Array<{
        id: string;
        displayName: string;
        description: string;
        template?: Record<string, unknown>;
      }>;
      modulePackages: Array<{
        moduleId: string;
        displayName: string;
        description: string;
        consumes: string[];
        produces: string[];
        requires: string[];
      }>;
      moduleInstances: unknown[];
    };
    expect(fresh.startingPoints.map(({ id }) => id)).toEqual(["github-development", "custom"]);
    expect(fresh.startingPoints[0]).toEqual(
      expect.objectContaining({
        displayName: "GitHub Development",
        description: expect.stringContaining("GitHub"),
      }),
    );
    expect(fresh.startingPoints[1]).toEqual(
      expect.objectContaining({
        displayName: "Custom composition",
      }),
    );
    expect(fresh.modulePackages).toContainEqual(
      expect.objectContaining({
        moduleId: "jarvis.module.development",
        displayName: "Development",
        description: "Implements a requested work item in an isolated Git workspace.",
        consumes: ["development.implementation.requested.v1"],
        requires: expect.arrayContaining(["agent.execute", "repository.write"]),
      }),
    );
    expect(fresh.moduleInstances).toEqual([]);

    const template = fresh.startingPoints[0]?.template as {
      slots: Record<string, unknown>;
      modules: Array<Record<string, unknown>>;
    };
    expect(Object.keys(template.slots)).toEqual(["agentRuntime", "sourceControl", "tickets"]);
    expect(template.modules.map(({ instanceId }) => instanceId)).toEqual([
      "github",
      "automation-rules",
      "development",
    ]);
    expect(template.modules[0]?.["configuration"]).toEqual({
      bootstrapLabelPolicy: "ignore-existing",
      pollIntervalSeconds: 60,
      repositories: ["main"],
    });

    const guidedResponse = await preview(engine, project.id, template);
    expect(guidedResponse.status, await guidedResponse.clone().text()).toBe(200);
    const guided = (await guidedResponse.json()) as {
      moduleInstances: Array<{
        instanceId: string;
        displayName: string;
        compatibility: string;
        missingResources: string[];
      }>;
      choices: Array<{ type: string; routing: { status: string } }>;
    };
    expect(guided.moduleInstances).toEqual([
      expect.objectContaining({
        instanceId: "automation-rules",
        displayName: "Automation Rules",
        compatibility: "compatible",
        missingResources: [],
      }),
      expect.objectContaining({
        instanceId: "development",
        displayName: "Development",
        compatibility: "compatible",
        missingResources: [
          "agent.execute",
          "git.branch",
          "git.commit",
          "git.push",
          "repository.write",
          "shell.execute",
          "work-items.read",
        ],
      }),
      expect.objectContaining({
        instanceId: "github",
        displayName: "GitHub",
        compatibility: "compatible",
        missingResources: ["github.api"],
      }),
    ]);
    expect(
      guided.choices.find(({ type }) => type === "development.implementation.requested")?.routing
        .status,
    ).toBe("resolved");

    const bindings = (await (await engine.call(`/v1/projects/${project.id}/bindings`)).json()) as {
      slots: Record<string, unknown>;
    };
    expect(bindings.slots).toEqual({});
    const unchanged = (await (await engine.call(`/v1/projects/${project.id}`)).json()) as {
      portableConfig: { modules: unknown[]; slots: Record<string, unknown> };
    };
    expect(unchanged.portableConfig.modules).toEqual([]);
    expect(unchanged.portableConfig.slots).toEqual({});
  });

  it("previews deterministic contract-owned choices for the canonical composition without mutation", async () => {
    const { engine, project } = await setup();
    const before = await (await engine.call(`/v1/projects/${project.id}`)).json();

    const response = await preview(engine, project.id);
    expect(response.status, `${await response.clone().text()}\n${engine.stderr()}`).toBe(200);
    const body = (await response.json()) as {
      choices: Array<Record<string, unknown>>;
      modulePackages: Array<{
        moduleId: string;
        configurationSchema: {
          properties?: Record<string, Record<string, unknown>>;
        } | null;
      }>;
    };
    expect(validatePreview(body), explain(validatePreview)).toBe(true);
    const automationPackage = body.modulePackages.find(
      ({ moduleId }) => moduleId === "jarvis.module.automation-rules",
    );
    expect(automationPackage?.configurationSchema?.properties?.["rules"]).toEqual(
      expect.objectContaining({ $comment: "jarvis:automation-rule-set" }),
    );
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

  it("validates and round-trips canonical Automation Rules without UI-only state", async () => {
    const { engine, project } = await setup();
    const portableConfig = structuredClone(project.portableConfig);
    const modules = portableConfig["modules"] as Array<Record<string, unknown>>;
    const automation = modules.find(
      (module) => module["moduleId"] === "jarvis.module.automation-rules",
    )!;
    const configuration = automation["configuration"] as {
      rules: Array<{
        when: { eventType: string; equals: Record<string, unknown> };
        emit: { type: string };
      }>;
    };
    configuration.rules[0]!.when.equals = { "payload.tag": "agent:queued" };
    const github = modules.find((module) => module["moduleId"] === "jarvis.module.github")!;
    github["configuration"] = {
      pollIntervalSeconds: 75,
      repositories: ["main"],
      bootstrapLabelPolicy: "emit-existing",
    };
    const development = modules.find(
      (module) => module["moduleId"] === "jarvis.module.development",
    )!;
    development["configuration"] = {
      validationOrder: ["typecheck", "test", "build"],
      maxRepairCycles: 3,
      retainWorkspaceOnSuccess: true,
    };

    const saved = await engine.call(`/v1/projects/${project.id}/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portableConfig, writeToRepository: false }),
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const reopened = (await (await engine.call(`/v1/projects/${project.id}`)).json()) as {
      portableConfig: Record<string, unknown>;
    };
    const reopenedAutomation = (
      reopened.portableConfig["modules"] as Array<Record<string, unknown>>
    ).find((module) => module["moduleId"] === "jarvis.module.automation-rules")!;
    expect(reopenedAutomation["configuration"]).toEqual(automation["configuration"]);
    expect(reopened.portableConfig["modules"]).toEqual(modules);

    configuration.rules[0]!.when.equals = {
      "payload.tag": { nested: "values are not a bounded scalar match" },
    };
    const invalid = await engine.call(`/v1/projects/${project.id}/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portableConfig, writeToRepository: false }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "project.config-invalid" }),
      }),
    );
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
