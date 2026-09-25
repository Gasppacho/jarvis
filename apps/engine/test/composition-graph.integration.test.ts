import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { explain, localApiValidator } from "./contract.js";
import { startEngine, type Harness } from "./harness.js";
import { makeNodeRepositoryFixture } from "./repository-fixture.js";
import { fixedProjectConfiguration } from "./reference-workflow-fixture.js";
import { ConnectionDescriptorStore } from "../src/connections/registry.js";

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
  let validateProjectGraph: ReturnType<typeof localApiValidator>;

  beforeAll(() => {
    validateGraph = localApiValidator("ProjectCompositionGraphV1");
    validateProjectGraph = localApiValidator("ProjectGraph");
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
    const fixed = fixedProjectConfiguration("composition-graph");
    const portableConfig = {
      ...fixed,
      repositories: fixed.repositories,
    };
    const imported = await engine.call("/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryPath }),
    });
    expect(imported.status).toBe(201);
    const draft = (await imported.json()) as {
      id: string;
      portableConfig: Record<string, unknown>;
    };
    const saved = await engine.call(`/v1/projects/${draft.id}/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portableConfig, writeToRepository: false }),
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const project = { ...draft, portableConfig };
    return { engine, project, repositoryPath };
  }

  const graph = (engine: Harness, projectId: string, portableConfig?: unknown) =>
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
    portableConfig: unknown,
    first: unknown,
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

  describe("GET /v1/projects/:projectId/graph", () => {
    it("returns the typed empty graph before the Project is activated", async () => {
      const { engine, project } = await setupCanonicalProject();

      const response = await engine.call(`/v1/projects/${project.id}/graph`);
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;

      expect(validateProjectGraph(body), explain(validateProjectGraph)).toBe(true);
      expect(body).toEqual({ nodes: [], edges: [], valid: true, issues: [] });
    });

    it("preserves the project 404 and loopback/bearer refusal contracts", async () => {
      const engine = await startEngine();
      engines.push(engine);

      const unauthenticated = await engine.callUnauthenticated("/v1/projects/does-not-exist/graph");
      expect(unauthenticated.status).toBe(401);
      expect((await unauthenticated.json()) as unknown).toMatchObject({
        error: { code: "api.unauthorized" },
      });

      const nonLoopback = await engine.callRaw("/v1/projects/does-not-exist/graph", {
        host: "jarvis.example.com",
        authorization: `Bearer ${engine.token}`,
      });
      expect(nonLoopback.status).toBe(403);
      expect(JSON.parse(nonLoopback.body) as unknown).toMatchObject({
        error: { code: "api.host-not-allowed" },
      });

      const unknown = await engine.call("/v1/projects/does-not-exist/graph");
      expect(unknown.status).toBe(404);
      expect((await unknown.json()) as unknown).toMatchObject({
        error: { code: "project.not-found" },
      });
    });
  });

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

    // Nodes: the fixed composition contains GitHub, Development, and Pull Request.
    expect(body.nodes.map((node) => node.instanceId)).toEqual([
      "development",
      "github",
      "pull-request",
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

    // Development reports completion to Pull Request; GitHub observes work items
    // for Development. Missing Local Bindings affect the rail, not routing.
    expect(body.edges).toContainEqual({
      kind: "request",
      contract: { type: "development.implementation.requested", version: 1, kind: "request" },
      from: { instanceId: "development", moduleId: "jarvis.module.development" },
      to: { instanceId: "development", moduleId: "jarvis.module.development" },
      routing: {
        status: "resolved",
        consumer: { instanceId: "development", moduleId: "jarvis.module.development" },
      },
      findings: [],
    });
    expect(body.edges).toContainEqual({
      kind: "fact",
      contract: { type: "scm.work-item.observed", version: 1, kind: "fact" },
      from: { instanceId: "github", moduleId: "jarvis.module.github" },
      to: { instanceId: "development", moduleId: "jarvis.module.development" },
      findings: [],
    });
    expect(body.edges).toContainEqual({
      kind: "fact",
      contract: { type: "development.implementation.completed", version: 1, kind: "fact" },
      from: { instanceId: "development", moduleId: "jarvis.module.development" },
      to: { instanceId: "pull-request", moduleId: "jarvis.module.pull-request" },
      findings: [],
    });

    // Rail: every required Slot has no Local Binding, so each is unresolved and
    // references the finding it caused.
    for (const slot of ["sourceControl", "agentRuntime"]) {
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

  it("projects fixed GitHub to Development facts, both requests, and orphan outputs", async () => {
    const { engine, project } = await setupCanonicalProject();
    const fixed = {
      ...project.portableConfig,
      compositionMode: "fixed-modules" as const,
      slots: {
        agentRuntime: { requires: "agent.execute" },
        sourceControl: { requires: "scm.change-request.manage" },
      },
      modules: project.portableConfig.modules
        .filter((module) => module.moduleId !== "jarvis.module.automation-rules")
        .map((module) => {
          const copy = structuredClone(module);
          if (copy.instanceId === "github")
            return { ...copy, bindings: { sourceControl: "sourceControl" } };
          if (copy.instanceId === "development")
            return { ...copy, bindings: { repository: "main" } };
          return copy;
        }),
    };

    const response = await graph(engine, project.id, fixed);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      edges: Array<{
        kind: string;
        contract: { type: string };
        from: { instanceId: string };
        to?: { instanceId: string };
        routing?: { status: string };
      }>;
    };
    expect(body.edges).toContainEqual(
      expect.objectContaining({
        kind: "fact",
        contract: { type: "scm.work-item.observed", version: 1, kind: "fact" },
        from: { instanceId: "github", moduleId: "jarvis.module.github" },
        to: { instanceId: "development", moduleId: "jarvis.module.development" },
      }),
    );
    expect(body.edges).toContainEqual(
      expect.objectContaining({
        kind: "request",
        contract: { type: "development.implementation.requested", version: 1, kind: "request" },
        from: { instanceId: "development", moduleId: "jarvis.module.development" },
        to: { instanceId: "development", moduleId: "jarvis.module.development" },
        routing: expect.objectContaining({ status: "resolved" }),
      }),
    );
    expect(body.edges).toContainEqual(
      expect.objectContaining({
        kind: "request",
        contract: { type: "scm.change-request.creation-requested", version: 1, kind: "request" },
        from: { instanceId: "pull-request", moduleId: "jarvis.module.pull-request" },
        to: { instanceId: "github", moduleId: "jarvis.module.github" },
        routing: expect.objectContaining({ status: "resolved" }),
      }),
    );
    for (const type of ["scm.work-item.ready", "scm.work-item.tag-added"]) {
      expect(body.edges).toContainEqual(
        expect.objectContaining({
          kind: "fact",
          contract: expect.objectContaining({ type }),
          from: { instanceId: "github", moduleId: "jarvis.module.github" },
        }),
      );
      expect(
        body.edges.find((edge) => edge.kind === "fact" && edge.contract.type === type)?.to,
      ).toBeUndefined();
    }
    expect(body.edges.some((edge) => edge.from.instanceId === "automation-rules")).toBe(false);
  });

  it("projects an orphaned request and a disabled node for a proposed configuration", async () => {
    const { engine, project } = await setupCanonicalProject();
    const proposed = {
      ...project.portableConfig,
      modules: project.portableConfig.modules.map((module) =>
        module.instanceId === "github" ? { ...module, enabled: false } : module,
      ),
    };

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
    expect(body.nodes.map((node) => node.instanceId)).toEqual([
      "development",
      "github",
      "pull-request",
    ]);

    // The disabled GitHub produces no fact edge; Pull Request's creation request
    // is now orphaned because its only GitHub consumer is disabled.
    expect(body.edges).toHaveLength(4);
    expect(body.edges).toContainEqual({
      kind: "request",
      contract: { type: "scm.change-request.creation-requested", version: 1, kind: "request" },
      from: { instanceId: "pull-request", moduleId: "jarvis.module.pull-request" },
      routing: { status: "orphaned" },
      findings: ["project.request-orphaned"],
    });
    expect(body.edges).toContainEqual({
      kind: "request",
      contract: { type: "development.implementation.requested", version: 1, kind: "request" },
      from: { instanceId: "development", moduleId: "jarvis.module.development" },
      to: { instanceId: "development", moduleId: "jarvis.module.development" },
      routing: {
        status: "resolved",
        consumer: { instanceId: "development", moduleId: "jarvis.module.development" },
      },
      findings: [],
    });
    expect(body.edges).toContainEqual({
      kind: "fact",
      contract: {
        type: "development.implementation.completed",
        version: 1,
        kind: "fact",
      },
      from: { instanceId: "development", moduleId: "jarvis.module.development" },
      to: { instanceId: "pull-request", moduleId: "jarvis.module.pull-request" },
      findings: [],
    });
    expect(body.edges).toContainEqual({
      kind: "fact",
      contract: { type: "development.implementation.failed", version: 1, kind: "fact" },
      from: { instanceId: "development", moduleId: "jarvis.module.development" },
      findings: [],
    });
    expect(body.findings.map((finding) => finding.code)).toContain("project.request-orphaned");

    await assertDeterministicAndUnmutated(engine, project.id, proposed, body);
  });

  it("names an ambiguous request's candidate consumers for a proposed configuration", async () => {
    const { engine, project } = await setupCanonicalProject();
    const github = project.portableConfig.modules.find(
      (module) => module.moduleId === "jarvis.module.github",
    )!;
    const proposed = {
      ...project.portableConfig,
      modules: [...project.portableConfig.modules, { ...github, instanceId: "github-secondary" }],
    };

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
      from: { instanceId: "pull-request" },
      routing: { status: "ambiguous" },
      findings: ["project.request-ambiguous"],
    });
    expect(ambiguous?.routing?.candidates?.map((candidate) => candidate.instanceId).sort()).toEqual(
      ["github", "github-secondary"],
    );

    // Development's direct-target request remains resolved; each GitHub instance
    // still publishes its historical facts without a Rules consumer.
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

    await assertDeterministicAndUnmutated(engine, project.id, proposed, body);
  });

  it("projects a fully bound fixed composition: resolved routing, bound rail, no findings", async () => {
    const { engine, project, repositoryPath } = await setupCanonicalProject();
    const database = new Database(join(engine.dataRoot, "jarvis.sqlite"));
    new ConnectionDescriptorStore(database).upsert({
      id: "connection/composition-graph-github",
      provider: "github",
      accountLabel: "Composition Graph GitHub",
      capabilities: ["github.api", "scm.change-request.manage", "work-items.read"],
      status: "available",
      secretRef: "gh://CompositionGraph",
    });
    database.close();

    const repositoryBinding = await engine.call(
      `/v1/projects/${project.id}/repositories/main/binding`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: repositoryPath, bookmarkRef: "bookmark/composition-graph" }),
      },
    );
    expect(repositoryBinding.status, await repositoryBinding.clone().text()).toBe(200);

    const bindings = (await (
      await engine.call(`/v1/projects/${project.id}/bindings`)
    ).json()) as Record<string, unknown>;
    const boundResponse = await engine.call(`/v1/projects/${project.id}/bindings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...bindings,
        slots: {
          ...(bindings["slots"] as Record<string, unknown>),
          sourceControl: {
            kind: "connection",
            ref: "connection/composition-graph-github",
          },
          agentRuntime: { kind: "runtime", ref: "runtime/fake-test" },
        },
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

    expect(body.nodes.map((node) => node["instanceId"])).toEqual([
      "development",
      "github",
      "pull-request",
    ]);
    expect(
      body.nodes.every(
        (node) => node["enabled"] === true && (node["findings"] as unknown[]).length === 0,
      ),
    ).toBe(true);
    expect(body.edges).toContainEqual({
      kind: "fact",
      contract: { type: "scm.work-item.observed", version: 1, kind: "fact" },
      from: { instanceId: "github", moduleId: "jarvis.module.github" },
      to: { instanceId: "development", moduleId: "jarvis.module.development" },
      findings: [],
    });
    expect(body.edges).toContainEqual({
      kind: "fact",
      contract: { type: "development.implementation.completed", version: 1, kind: "fact" },
      from: { instanceId: "development", moduleId: "jarvis.module.development" },
      to: { instanceId: "pull-request", moduleId: "jarvis.module.pull-request" },
      findings: [],
    });
    expect(body.edges).toContainEqual({
      kind: "request",
      contract: { type: "development.implementation.requested", version: 1, kind: "request" },
      from: { instanceId: "development", moduleId: "jarvis.module.development" },
      to: { instanceId: "development", moduleId: "jarvis.module.development" },
      routing: {
        status: "resolved",
        consumer: { instanceId: "development", moduleId: "jarvis.module.development" },
      },
      findings: [],
    });
    expect(body.edges).toContainEqual({
      kind: "request",
      contract: { type: "scm.change-request.creation-requested", version: 1, kind: "request" },
      from: { instanceId: "pull-request", moduleId: "jarvis.module.pull-request" },
      to: { instanceId: "github", moduleId: "jarvis.module.github" },
      routing: {
        status: "resolved",
        consumer: { instanceId: "github", moduleId: "jarvis.module.github" },
      },
      findings: [],
    });
    expect(body.rail.every((item) => (item["findings"] as unknown[]).length === 0)).toBe(true);
    expect(
      body.rail
        .filter((item) => item["kind"] === "slot")
        .every((item) => item["state"] === "bound"),
    ).toBe(true);
    expect(body.findings).toEqual([]);

    await assertDeterministicAndUnmutated(engine, project.id, undefined, body);
  });
});
