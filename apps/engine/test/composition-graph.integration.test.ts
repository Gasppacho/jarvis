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

/**
 * The composition graph is a read-only projection of the same validator the
 * composition-review and composition-choices operations already exercise:
 * these fixtures reuse their canonical project and their orphaned/ambiguous
 * mutations, then assert the graph's own shape (nodes, edges, routing, rail,
 * finding references) rather than re-deriving routing.
 */
describe("project composition graph", () => {
  const engines: Harness[] = [];
  const repositories: string[] = [];
  const runtimeRoots: string[] = [];
  let validateGraph: ReturnType<typeof localApiValidator>;

  beforeAll(() => {
    validateGraph = localApiValidator("ProjectCompositionGraphV1");
  });

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
    for (const root of [...repositories.splice(0), ...runtimeRoots.splice(0)]) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function setupCanonicalProject() {
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

  const graph = (engine: Harness, projectId: string, portableConfig?: Record<string, unknown>) =>
    engine.call(`/v1/projects/${projectId}/composition-graph`, {
      method: "POST",
      ...(portableConfig === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ portableConfig }),
          }),
    });

  /** Asserts the model is well-formed, deterministic and mutates nothing. */
  async function assertDeterministicAndUnmutated(
    engine: Harness,
    projectId: string,
    portableConfig: Record<string, unknown> | undefined,
    first: Record<string, unknown>,
  ) {
    expect(validateGraph(first), explain(validateGraph)).toBe(true);
    const beforeProject = await (await engine.call(`/v1/projects/${projectId}`)).json();
    const beforeBindings = await (await engine.call(`/v1/projects/${projectId}/bindings`)).json();

    const second = await (await graph(engine, projectId, portableConfig)).json();
    expect(second).toEqual(first);

    expect(await (await engine.call(`/v1/projects/${projectId}`)).json()).toEqual(beforeProject);
    expect(await (await engine.call(`/v1/projects/${projectId}/bindings`)).json()).toEqual(
      beforeBindings,
    );
  }

  it("projects an incomplete saved composition: unbound rail, direct-target and broadcast edges", async () => {
    const { engine, project } = await setupCanonicalProject();

    const response = await graph(engine, project.id, undefined);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      apiVersion: string;
      kind: string;
      projectId: string;
      nodes: Array<{
        instanceId: string;
        moduleId: string;
        enabled: boolean;
        moduleVersion: string | null;
        displayName: string | null;
        findings: string[];
      }>;
      edges: Array<Record<string, unknown>>;
      rail: Array<Record<string, unknown>>;
      findings: Array<{ id: string; code: string }>;
    };

    expect(body).toMatchObject({
      apiVersion: "jarvis.dev/project-composition-graph/v1",
      kind: "ProjectCompositionGraph",
      projectId: project.id,
    });

    // Nodes: stable identity, module package identity, display name, enabled state -
    // sorted by instanceId (automation-rules, development, github).
    expect(body.nodes.map((node) => node.instanceId)).toEqual([
      "automation-rules",
      "development",
      "github",
    ]);
    expect(body.nodes.every((node) => node.enabled)).toBe(true);
    expect(body.nodes).toContainEqual(
      expect.objectContaining({
        instanceId: "github",
        moduleId: "jarvis.module.github",
        moduleVersion: "1.0.0",
        displayName: "GitHub",
      }),
    );

    // Edges: request routing resolves via a direct configured target regardless of
    // unbound Local Bindings; the broadcast fact edge carries no routing.
    expect(body.edges).toContainEqual({
      kind: "request",
      contract: { type: "development.implementation.requested", version: 1, kind: "request" },
      from: { instanceId: "automation-rules", moduleId: "jarvis.module.automation-rules" },
      to: { instanceId: "development", moduleId: "jarvis.module.development" },
      routing: {
        status: "resolved",
        consumer: { instanceId: "development", moduleId: "jarvis.module.development" },
      },
      findings: [],
    });
    expect(body.edges).toContainEqual({
      kind: "fact",
      contract: { type: "scm.work-item.tag-added", version: 1, kind: "fact" },
      from: { instanceId: "github", moduleId: "jarvis.module.github" },
      to: { instanceId: "automation-rules", moduleId: "jarvis.module.automation-rules" },
      findings: [],
    });

    // Rail: every required Slot has no Local Binding, so each is unresolved and
    // references the finding it caused.
    for (const slot of ["sourceControl", "tickets", "agentRuntime"]) {
      const item = body.rail.find((entry) => entry["kind"] === "slot" && entry["slot"] === slot);
      expect(item, `expected a rail item for slot ${slot}`).toMatchObject({
        state: "unresolved",
        findings: ["project.binding-missing"],
      });
      expect(item).not.toHaveProperty("binding");
    }
    // The github Module Instance's own capability requirement is unresolved too,
    // through the same unbound sourceControl Slot.
    expect(body.rail).toContainEqual(
      expect.objectContaining({
        kind: "module-instance",
        instanceId: "github",
        capability: "github.api",
        state: "unresolved",
        findings: ["project.capability-unresolved"],
      }),
    );

    // Findings: every finding has a stable address and the codes used above exist
    // among them.
    expect(body.findings.every((finding) => /^f[1-9][0-9]*$/.test(finding.id))).toBe(true);
    expect(body.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["project.binding-missing", "project.capability-unresolved"]),
    );

    await assertDeterministicAndUnmutated(engine, project.id, undefined, body);
  });

  it("projects an orphaned request and a disabled node for a proposed configuration", async () => {
    const { engine, project } = await setupCanonicalProject();
    const proposed = structuredClone(project.portableConfig);
    const modules = proposed["modules"] as Array<Record<string, unknown>>;
    const github = modules.find((module) => module["instanceId"] === "github")!;
    github["enabled"] = false;
    modules.splice(
      modules.findIndex((module) => module["instanceId"] === "development"),
      1,
    );

    const response = await graph(engine, project.id, proposed);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      nodes: Array<{ instanceId: string; enabled: boolean }>;
      edges: Array<Record<string, unknown>>;
      findings: Array<{ code: string }>;
    };

    expect(body.nodes).toContainEqual(
      expect.objectContaining({ instanceId: "github", enabled: false }),
    );
    expect(body.nodes.map((node) => node.instanceId)).toEqual(["automation-rules", "github"]);

    // The disabled github produces no fact edge; the only edge left is the
    // now-orphaned request, which names no candidates.
    expect(body.edges).toEqual([
      {
        kind: "request",
        contract: { type: "development.implementation.requested", version: 1, kind: "request" },
        from: { instanceId: "automation-rules", moduleId: "jarvis.module.automation-rules" },
        routing: { status: "orphaned" },
        findings: ["project.request-orphaned"],
      },
    ]);
    expect(body.findings.map((finding) => finding.code)).toContain("project.request-orphaned");

    await assertDeterministicAndUnmutated(
      engine,
      project.id,
      proposed,
      body as unknown as Record<string, unknown>,
    );
  });

  it("names an ambiguous request's candidate consumers for a proposed configuration", async () => {
    const { engine, project } = await setupCanonicalProject();
    const proposed = structuredClone(project.portableConfig);
    const modules = proposed["modules"] as Array<Record<string, unknown>>;
    const github = modules.find((module) => module["moduleId"] === "jarvis.module.github")!;
    modules.push({ ...structuredClone(github), instanceId: "github-secondary" });

    const response = await graph(engine, project.id, proposed);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      edges: Array<{
        kind: string;
        contract: { type: string };
        from: { instanceId: string };
        routing?: { status: string; candidates?: Array<{ instanceId: string }> };
        findings: string[];
      }>;
      findings: Array<{ code: string }>;
    };

    const ambiguous = body.edges.find(
      (edge) => edge.contract.type === "scm.change-request.creation-requested",
    );
    expect(ambiguous).toMatchObject({
      kind: "request",
      from: { instanceId: "development" },
      routing: { status: "ambiguous" },
      findings: ["project.request-ambiguous"],
    });
    expect(ambiguous?.routing?.candidates?.map((candidate) => candidate.instanceId).sort()).toEqual(
      ["github", "github-secondary"],
    );

    // The direct-target request is untouched by the duplication; each github
    // instance still broadcasts its own fact to automation-rules.
    expect(
      body.edges.find((edge) => edge.contract.type === "development.implementation.requested")
        ?.routing?.status,
    ).toBe("resolved");
    expect(
      body.edges
        .filter((edge) => edge.contract.type === "scm.work-item.tag-added")
        .map((edge) => edge.from.instanceId),
    ).toEqual(["github", "github-secondary"]);
    expect(body.findings.map((finding) => finding.code)).toContain("project.request-ambiguous");

    await assertDeterministicAndUnmutated(
      engine,
      project.id,
      proposed,
      body as unknown as Record<string, unknown>,
    );
  });

  it("projects a fully bound saved composition: resolved routing, bound rail, no findings", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "jarvis-composition-graph-"));
    runtimeRoots.push(fixtureRoot);
    const runtimeRoot = join(fixtureRoot, "engine");
    cpSync(join(REPO_ROOT, "dist/engine"), runtimeRoot, { recursive: true });
    // A zero-requirement worker: providing work-items.read is enough to bind the
    // Project's only Slot and resolve automation-rules' direct-target request.
    writeFileSync(
      join(runtimeRoot, "modules/change-request-review/module.manifest.yaml"),
      `apiVersion: jarvis.dev/module/v1
kind: Module
metadata:
  id: jarvis.module.change-request-review
  version: 1.0.0
  displayName: Request Worker
  description: Test worker for a fully bound composition graph.
  categories: [automation]
runtime:
  entrypoint: dist/index.mjs
contracts:
  consumes:
    - type: development.implementation.requested
      version: 1
      kind: request
      schemaRef: contracts/events/development.implementation.requested.v1.schema.json
      handler: handleImplementationRequested
  produces: []
capabilities:
  requires: []
  provides:
    - id: work-items.read
      description: Embedded work item access.
`,
      "utf8",
    );
    const engine = await startEngine({ enginePath: join(runtimeRoot, "engine.bundle.mjs") });
    engines.push(engine);
    const repositoryPath = makeNodeRepositoryFixture();
    repositories.push(repositoryPath);
    const portableConfig = parseYaml(
      readFileSync(join(REPO_ROOT, "examples/project/.jarvis/project.yaml"), "utf8"),
    ) as Record<string, unknown>;
    portableConfig["slots"] = { tickets: { requires: "work-items.read" } };
    portableConfig["modules"] = [
      {
        instanceId: "automation-rules",
        moduleId: "jarvis.module.automation-rules",
        enabled: true,
        configuration: {
          rules: [
            {
              id: "emit-request",
              when: { eventType: "scm.work-item.tag-added" },
              emit: {
                type: "development.implementation.requested",
                target: { moduleInstanceId: "request-worker" },
              },
            },
          ],
        },
      },
      {
        instanceId: "request-worker",
        moduleId: "jarvis.module.change-request-review",
        enabled: true,
      },
    ];
    const imported = await engine.call("/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryPath, portableConfig }),
    });
    expect(imported.status, await imported.clone().text()).toBe(201);
    const project = (await imported.json()) as { id: string };

    const bindings = await (await engine.call(`/v1/projects/${project.id}/bindings`)).json();
    const boundResponse = await engine.call(`/v1/projects/${project.id}/bindings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(bindings as Record<string, unknown>),
        slots: { tickets: { kind: "module-instance", ref: "request-worker" } },
      }),
    });
    expect(boundResponse.status, await boundResponse.clone().text()).toBe(200);

    const response = await graph(engine, project.id, undefined);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
      rail: Array<Record<string, unknown>>;
      findings: Array<unknown>;
    };

    expect(body.nodes).toEqual([
      expect.objectContaining({
        instanceId: "automation-rules",
        moduleId: "jarvis.module.automation-rules",
        enabled: true,
        findings: [],
      }),
      expect.objectContaining({
        instanceId: "request-worker",
        moduleId: "jarvis.module.change-request-review",
        displayName: "Request Worker",
        enabled: true,
        findings: [],
      }),
    ]);
    expect(body.edges).toEqual([
      {
        kind: "request",
        contract: { type: "development.implementation.requested", version: 1, kind: "request" },
        from: { instanceId: "automation-rules", moduleId: "jarvis.module.automation-rules" },
        to: { instanceId: "request-worker", moduleId: "jarvis.module.change-request-review" },
        routing: {
          status: "resolved",
          consumer: {
            instanceId: "request-worker",
            moduleId: "jarvis.module.change-request-review",
          },
        },
        findings: [],
      },
    ]);
    expect(body.rail).toEqual([
      {
        kind: "slot",
        slot: "tickets",
        capability: "work-items.read",
        state: "bound",
        binding: { kind: "module-instance", ref: "request-worker" },
        source: { kind: "module-instance", ref: "request-worker" },
        findings: [],
      },
    ]);
    expect(body.findings).toEqual([]);

    await assertDeterministicAndUnmutated(
      engine,
      project.id,
      undefined,
      body as unknown as Record<string, unknown>,
    );
  });
});
