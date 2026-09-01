import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { explain, localApiValidator } from "./contract.js";
import { startEngine, type Harness } from "./harness.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("bundled Module Package catalogue", () => {
  const started: Harness[] = [];
  let validatePackage: ReturnType<typeof localApiValidator>;

  beforeAll(() => {
    validatePackage = localApiValidator("ModulePackage");
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((engine) => engine.dispose()));
  });

  it("exposes the validated Development package through the Local API", async () => {
    expect(
      existsSync(join(REPO_ROOT, "dist/engine/modules/development/module.manifest.yaml")),
    ).toBe(true);
    expect(
      existsSync(join(REPO_ROOT, "dist/engine/contracts/schemas/module-manifest.v1.schema.json")),
    ).toBe(true);
    expect(existsSync(join(REPO_ROOT, "dist/engine/modules/development/dist/index.mjs"))).toBe(
      true,
    );
    expect(
      JSON.parse(readFileSync(join(REPO_ROOT, "dist/engine/module-registry.json"), "utf8")),
    ).toEqual({ packages: ["development"] });
    const configurationSchema = JSON.parse(
      readFileSync(join(REPO_ROOT, "contracts/module-config/development.v1.schema.json"), "utf8"),
    ) as Record<string, unknown>;

    const engine = await startEngine();
    started.push(engine);

    const response = await engine.call("/v1/module-catalog");
    expect(response.status).toBe(200);

    const body = (await response.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
    expect(validatePackage(body.items[0]), explain(validatePackage)).toBe(true);
    expect(body.items[0]).toEqual({
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
      configurationSchema,
    });
  });
});
