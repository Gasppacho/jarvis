import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { explain, localApiValidator } from "./contract.js";
import { startEngine, type Harness } from "./harness.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

interface CatalogItem {
  readonly moduleId: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly categories: string[];
  readonly consumes: string[];
  readonly produces: string[];
  readonly requires: string[];
  readonly provides: string[];
  readonly configurationSchemaRef: string | null;
  readonly configurationSchema: Record<string, unknown> | null;
}

describe("bundled Module Package catalogue", () => {
  const started: Harness[] = [];
  const fixtureRoots: string[] = [];
  let validatePackage: ReturnType<typeof localApiValidator>;

  beforeAll(() => {
    validatePackage = localApiValidator("ModulePackage");
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((engine) => engine.dispose()));
    for (const root of fixtureRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function copiedRuntime(): string {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "jarvis-module-runtime-"));
    fixtureRoots.push(fixtureRoot);
    const runtimeRoot = join(fixtureRoot, "engine");
    cpSync(join(REPO_ROOT, "dist/engine"), runtimeRoot, { recursive: true });
    return runtimeRoot;
  }

  function runtimeWithGithubManifest(fixtureName: string): string {
    const runtimeRoot = copiedRuntime();
    copyFileSync(
      join(REPO_ROOT, "apps/engine/test/fixtures/modules", fixtureName),
      join(runtimeRoot, "modules/github/module.manifest.yaml"),
    );
    return runtimeRoot;
  }

  async function expectOnlyValidPackages(engine: Harness): Promise<void> {
    const response = await engine.call("/v1/module-catalog");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: CatalogItem[] };
    expect(body.items.map((item) => item.moduleId)).toEqual([
      "jarvis.module.automation-rules",
      "jarvis.module.change-request-review",
      "jarvis.module.development",
    ]);
  }

  it("exposes every official MVP Module Package through the Local API", async () => {
    for (const name of ["automation-rules", "change-request-review", "development", "github"]) {
      expect(existsSync(join(REPO_ROOT, "dist/engine/modules", name, "module.manifest.yaml"))).toBe(
        true,
      );
      expect(existsSync(join(REPO_ROOT, "dist/engine/modules", name, "dist/index.mjs"))).toBe(true);
    }
    expect(
      existsSync(join(REPO_ROOT, "dist/engine/contracts/schemas/module-manifest.v1.schema.json")),
    ).toBe(true);

    const engine = await startEngine();
    started.push(engine);

    const response = await engine.call("/v1/module-catalog");
    expect(response.status).toBe(200);

    const body = (await response.json()) as { items: CatalogItem[] };
    expect(body.items).toHaveLength(4);
    for (const item of body.items) {
      expect(validatePackage(item), explain(validatePackage)).toBe(true);
    }
    expect(
      body.items.map(({ configurationSchema, ...item }) => ({
        ...item,
        configurationSchemaTitle: configurationSchema?.["title"] ?? null,
      })),
    ).toEqual([
      {
        moduleId: "jarvis.module.automation-rules",
        version: "1.0.0",
        displayName: "Automation Rules",
        description: "Translates matching project Facts into targeted Requests.",
        categories: ["automation"],
        consumes: ["scm.work-item.tag-added.v1"],
        produces: ["development.implementation.requested.v1"],
        requires: [],
        provides: [],
        configurationSchemaRef: "contracts/module-config/automation-rules.v1.schema.json",
        configurationSchemaTitle: "Automation Rules Module Config v1",
      },
      {
        moduleId: "jarvis.module.change-request-review",
        version: "1.0.0",
        displayName: "Change Request Review",
        description: "Inspects a created Change Request revision and records a local verdict.",
        categories: ["agentic", "decision"],
        consumes: ["scm.change-request.created.v1"],
        produces: [],
        requires: ["agent.execute"],
        provides: [],
        configurationSchemaRef: null,
        configurationSchemaTitle: null,
      },
      {
        moduleId: "jarvis.module.development",
        version: "1.0.0",
        displayName: "Development",
        description: "Implements a requested work item in an isolated Git workspace.",
        categories: ["agentic"],
        consumes: ["development.implementation.requested.v1"],
        produces: [
          "development.implementation.completed.v1",
          "development.implementation.failed.v1",
          "scm.change-request.creation-requested.v1",
        ],
        requires: [
          "repository.write",
          "git.branch",
          "git.commit",
          "git.push",
          "shell.execute",
          "work-items.read",
          "agent.execute",
        ],
        provides: [],
        configurationSchemaRef: "contracts/module-config/development.v1.schema.json",
        configurationSchemaTitle: "Development Module Config v1",
      },
      {
        moduleId: "jarvis.module.github",
        version: "1.0.0",
        displayName: "GitHub",
        description: "Translates GitHub observations and requested SCM actions.",
        categories: ["provider"],
        consumes: ["scm.change-request.creation-requested.v1"],
        produces: [
          "scm.work-item.tag-added.v1",
          "scm.change-request.created.v1",
          "scm.change-request.creation-failed.v1",
        ],
        requires: ["github.api"],
        provides: ["scm.change-request.manage", "work-items.read"],
        configurationSchemaRef: "contracts/module-config/github.v1.schema.json",
        configurationSchemaTitle: "GitHub Module Config v1",
      },
    ]);
  });

  it("serves schema-owned guidance for every bundled Module Configuration control", async () => {
    const engine = await startEngine();
    started.push(engine);

    const response = await engine.call("/v1/module-catalog");
    const body = (await response.json()) as { items: CatalogItem[] };
    const schemas = Object.fromEntries(
      body.items.flatMap((item) =>
        item.configurationSchema === null ? [] : [[item.moduleId, item.configurationSchema]],
      ),
    );

    expect(schemas["jarvis.module.github"]).toMatchObject({
      properties: {
        pollIntervalSeconds: {
          title: "Polling interval",
          description: expect.any(String),
          examples: [60],
          minimum: 15,
          maximum: 3600,
        },
        repositories: {
          title: "Repositories",
          description: expect.any(String),
          examples: [["main"]],
          minItems: 1,
        },
      },
    });
    expect(schemas["jarvis.module.development"]).toMatchObject({
      properties: {
        validationOrder: {
          title: "Validation order",
          examples: [["lint", "typecheck", "test", "build"]],
        },
        maxRepairCycles: { title: "Maximum repair cycles", default: 2 },
        retainWorkspaceOnSuccess: { title: "Retain successful workspace", default: false },
      },
    });
    expect(schemas["jarvis.module.automation-rules"]).toMatchObject({
      properties: {
        rules: { title: "Automation Rules", description: expect.any(String), minItems: 1 },
      },
    });
  });

  it("rejects a Manifest whose schemaRef identifies another versioned event", async () => {
    const runtimeRoot = copiedRuntime();
    const manifestPath = join(runtimeRoot, "modules/github/module.manifest.yaml");
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, "utf8").replace(
        "type: scm.work-item.tag-added",
        "type: scm.work-item.tag-removed",
      ),
    );
    const engine = await startEngine({ enginePath: join(runtimeRoot, "engine.bundle.mjs") });
    started.push(engine);

    await expectOnlyValidPackages(engine);
    await engine.waitForStderr("rejected bundled Module Package github");
    expect(engine.stderr()).toContain(
      "/contracts/produces/0/schemaRef must identify contracts/events/scm.work-item.tag-removed.v1.schema.json",
    );
  });

  it("rejects a schema-invalid Manifest without hiding valid packages", async () => {
    const runtimeRoot = runtimeWithGithubManifest("github-invalid-id.module.yaml");
    const engine = await startEngine({ enginePath: join(runtimeRoot, "engine.bundle.mjs") });
    started.push(engine);

    await expectOnlyValidPackages(engine);
    await engine.waitForStderr("rejected bundled Module Package github");
    expect(engine.stderr()).toContain("/metadata/id");
    expect(engine.stderr()).toContain("must match pattern");
  });

  it("isolates malformed YAML with a sanitized root diagnostic", async () => {
    const runtimeRoot = runtimeWithGithubManifest("github-malformed.module.fixture");
    const engine = await startEngine({ enginePath: join(runtimeRoot, "engine.bundle.mjs") });
    started.push(engine);

    await expectOnlyValidPackages(engine);
    await engine.waitForStderr("rejected bundled Module Package github");
    expect(engine.stderr()).toContain("/ Manifest is not valid YAML.");
    expect(engine.stderr()).not.toContain(runtimeRoot);
  });

  it("isolates a missing Manifest with a sanitized root diagnostic", async () => {
    const runtimeRoot = copiedRuntime();
    rmSync(join(runtimeRoot, "modules/github/module.manifest.yaml"));
    const engine = await startEngine({ enginePath: join(runtimeRoot, "engine.bundle.mjs") });
    started.push(engine);

    await expectOnlyValidPackages(engine);
    await engine.waitForStderr("rejected bundled Module Package github");
    expect(engine.stderr()).toContain("/ Manifest could not be read.");
    expect(engine.stderr()).not.toContain(runtimeRoot);
  });

  it("names the configuration reference when its schema is invalid", async () => {
    const runtimeRoot = copiedRuntime();
    copyFileSync(
      join(REPO_ROOT, "apps/engine/test/fixtures/modules/invalid-config-schema.json"),
      join(runtimeRoot, "contracts/module-config/github.v1.schema.json"),
    );

    const engine = await startEngine({ enginePath: join(runtimeRoot, "engine.bundle.mjs") });
    started.push(engine);

    await expectOnlyValidPackages(engine);
    await engine.waitForStderr("rejected bundled Module Package github");
    expect(engine.stderr()).toContain(
      "/configuration/schemaRef Configuration schema must be a JSON object.",
    );
    expect(engine.stderr()).not.toContain(runtimeRoot);
  });

  it("isolates a malformed configuration schema without exposing its path", async () => {
    const runtimeRoot = copiedRuntime();
    copyFileSync(
      join(REPO_ROOT, "apps/engine/test/fixtures/modules/malformed-config-schema.fixture"),
      join(runtimeRoot, "contracts/module-config/github.v1.schema.json"),
    );

    const engine = await startEngine({ enginePath: join(runtimeRoot, "engine.bundle.mjs") });
    started.push(engine);

    await expectOnlyValidPackages(engine);
    await engine.waitForStderr("rejected bundled Module Package github");
    expect(engine.stderr()).toContain(
      "/configuration/schemaRef Configuration schema could not be read as JSON.",
    );
    expect(engine.stderr()).not.toContain(runtimeRoot);
  });
});
