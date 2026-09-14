import { rmSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { explain, localApiValidator } from "./contract.js";
import { startEngine, type Harness } from "./harness.js";
import { makeNodeRepositoryFixture } from "./repository-fixture.js";
import { fixedProjectConfiguration } from "./reference-workflow-fixture.js";

describe("project composition choices", () => {
  const engines: Harness[] = [];
  const repositories: string[] = [];
  let validatePreview: ReturnType<typeof localApiValidator>;

  beforeAll(() => {
    validatePreview = localApiValidator("ProjectCompositionChoicesV1");
  });

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
    for (const root of repositories.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function setup() {
    const engine = await startEngine();
    engines.push(engine);
    const repositoryPath = makeNodeRepositoryFixture();
    repositories.push(repositoryPath);
    const portableConfig = fixedProjectConfiguration("composition-choices");
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
        requires: Array<{ id: string; binding?: string }>;
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
        consumes: ["scm.work-item.observed.v1", "development.implementation.requested.v1"],
        requires: expect.arrayContaining([
          { id: "agent.execute", binding: "agentRuntime" },
          { id: "repository.write", binding: "repository" },
        ]),
      }),
    );
    expect(fresh.moduleInstances).toEqual([]);
    expect(fresh.startingPoints[0]?.description).toContain(
      "Repository main → GitHub QServices/token-warehouse",
    );
    expect(fresh.startingPoints[0]?.description).toContain(
      "push remote origin; target branch main",
    );

    const template = fresh.startingPoints[0]?.template as {
      compositionMode: string;
      slots: Record<string, unknown>;
      modules: Array<Record<string, unknown>>;
    };
    expect(template.compositionMode).toBe("fixed-modules");
    expect(Object.keys(template.slots)).toEqual(["agentRuntime", "sourceControl"]);
    expect(template.modules.map(({ instanceId }) => instanceId)).toEqual(["github", "development"]);
    expect(template.modules[0]?.["configuration"]).toEqual({
      bootstrapLabelPolicy: "ignore-existing",
      pollIntervalSeconds: 60,
      repositories: ["main"],
      readyLabel: "ready-for-agent",
    });
    expect(template.modules[0]?.["bindings"]).toEqual({ sourceControl: "sourceControl" });
    expect(template.modules[1]?.["bindings"]).toEqual({ repository: "main" });

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
        instanceId: "development",
        displayName: "Development",
        compatibility: "compatible",
        missingResources: [
          "agent.execute",
          "git.branch",
          "git.commit",
          "git.push",
          "repository.write",
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

  it("keeps fixed internal capability routing and reports duplicate packages without mutation", async () => {
    const { engine, project } = await setup();
    const initial = (await (await preview(engine, project.id)).json()) as {
      startingPoints: Array<{ id: string; template: Record<string, unknown> }>;
    };
    const template = initial.startingPoints.find(({ id }) => id === "github-development")!.template;
    const fixed = structuredClone(template);
    const modules = fixed["modules"] as Array<Record<string, unknown>>;
    modules.push({ ...structuredClone(modules[0]), instanceId: "github-disabled", enabled: false });

    const reviewResponse = await engine.call(`/v1/projects/${project.id}/composition-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portableConfig: fixed }),
    });
    expect(reviewResponse.status, await reviewResponse.clone().text()).toBe(200);
    const review = (await reviewResponse.json()) as {
      validation: {
        findings: Array<{
          code: string;
          target: { kind: string; instanceId?: string; field?: string };
        }>;
        satisfiedCapabilities: Array<{ capability: string; source: { kind: string; ref: string } }>;
      };
      composition: { choices: Array<{ type: string; routing: { status: string } }> };
    };
    expect(review.validation.findings).toContainEqual(
      expect.objectContaining({
        code: "project.instance-config-invalid",
        target: { kind: "module-instance", instanceId: "github-disabled", field: "/moduleId" },
      }),
    );
    expect(review.validation.satisfiedCapabilities).toContainEqual({
      capability: "work-items.read",
      target: { kind: "module-instance", instanceId: "development" },
      source: { kind: "module-instance", ref: "github" },
    });
    expect(
      review.composition.choices.find(({ type }) => type === "development.implementation.requested")
        ?.routing.status,
    ).toBe("resolved");
    expect(await (await engine.call(`/v1/projects/${project.id}`)).json()).toMatchObject({
      portableConfig: project.portableConfig,
    });
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
    expect(
      body.modulePackages.some(({ moduleId }) => moduleId === "jarvis.module.automation-rules"),
    ).toBe(false);
    const choiceKeys = body.choices.map(
      (choice) =>
        `${String(choice["type"])}.v${String(choice["version"])}.${String(choice["kind"])}`,
    );
    expect(choiceKeys).toEqual([...choiceKeys].sort());
    expect(body.choices).toContainEqual(
      expect.objectContaining({
        label: "Work item observed",
        type: "scm.work-item.observed",
        version: 1,
        kind: "fact",
        description: "A provider-neutral snapshot of one externally observed work item.",
        payloadSchema: expect.objectContaining({ type: "object" }),
        producers: [{ instanceId: "github", moduleId: "jarvis.module.github" }],
        consumers: [
          {
            instanceId: "development",
            moduleId: "jarvis.module.development",
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
        producers: [{ instanceId: "development", moduleId: "jarvis.module.development" }],
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
    expect(disabled.choices).toEqual([]);

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
      "scm.work-item.observed",
    ]);
    expect(await (await engine.call(`/v1/projects/${project.id}`)).json()).toEqual(before);
  });

  it("rejects executable Automation Rules in the fixed production composition", async () => {
    const { engine, project } = await setup();
    const portableConfig = structuredClone(project.portableConfig);
    const modules = portableConfig["modules"] as Array<Record<string, unknown>>;
    modules.push({
      instanceId: "automation-rules",
      moduleId: "jarvis.module.automation-rules",
      enabled: true,
      configuration: { rules: [] },
    });

    const rejected = await engine.call(`/v1/projects/${project.id}/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portableConfig, writeToRepository: false }),
    });
    expect(rejected.status, await rejected.clone().text()).toBe(400);
    expect(await rejected.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "project.config-invalid" }),
      }),
    );
    const reopened = (await (await engine.call(`/v1/projects/${project.id}`)).json()) as {
      portableConfig: Record<string, unknown>;
    };
    expect(reopened.portableConfig["modules"]).toEqual(project.portableConfig["modules"]);
  });

  it("keeps the fixed implementation Request routed to Development", async () => {
    const { engine, project } = await setup();
    const portableConfig = structuredClone(project.portableConfig);
    const modules = portableConfig["modules"] as Array<Record<string, unknown>>;
    const development = modules.find((module) => module["instanceId"] === "development")!;
    modules.push({ ...structuredClone(development), instanceId: "development-2" });

    const response = await preview(engine, project.id);
    const body = (await response.json()) as {
      choices: Array<{ type: string; routing: { status: string; explanation: string } }>;
    };
    expect(
      body.choices.find((choice) => choice.type === "development.implementation.requested")
        ?.routing,
    ).toMatchObject({
      status: "resolved",
      selectedConsumer: { instanceId: "development", moduleId: "jarvis.module.development" },
    });
  });
});
