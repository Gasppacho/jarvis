import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const checker = join(repoRoot, "scripts", "contracts-check.mjs");
const roots: string[] = [];

/** A throwaway copy of the contract surface, ready to be broken on purpose. */
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-contracts-"));
  roots.push(root);
  for (const dir of ["contracts", "examples", "packages/modules"]) {
    cpSync(join(repoRoot, dir), join(root, dir), { recursive: true });
  }
  return root;
}

function runChecker(root: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [checker],
      { env: { ...process.env, JARVIS_CONTRACTS_ROOT: root } },
      (error, _stdout, stderr) => {
        resolve({ code: error === null ? 0 : ((error as { code?: number }).code ?? 1), stderr });
      },
    );
  });
}

function editJson(path: string, mutate: (value: Record<string, unknown>) => void): void {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(value);
  writeFileSync(path, JSON.stringify(value, null, 2));
}

/** Drops the first `key` line and everything nested under it. */
function removeYamlBlock(yaml: string, key: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line.trimStart() === key);
  if (start === -1) throw new Error(`no ${key} block to remove`);

  const indent = lines[start]!.length - lines[start]!.trimStart().length;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end]!;
    if (line.trim() !== "" && line.length - line.trimStart().length <= indent) break;
    end += 1;
  }
  lines.splice(start, end - start);
  return lines.join("\n");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pnpm contracts:check", () => {
  it("accepts the contract surface as committed", async () => {
    await expect(runChecker(fixtureRoot())).resolves.toMatchObject({ code: 0 });
  });

  it("rejects an event example that breaks the envelope", async () => {
    const root = fixtureRoot();
    editJson(join(root, "examples/events/01-work-item-tag-added.json"), (event) => {
      delete event["correlationId"];
    });

    const { code, stderr } = await runChecker(root);
    expect(code).not.toBe(0);
    expect(stderr).toContain("event-envelope-invalid");
  });

  it("rejects an event example whose payload breaks its own contract", async () => {
    const root = fixtureRoot();
    editJson(join(root, "examples/events/01-work-item-tag-added.json"), (event) => {
      (event["payload"] as Record<string, unknown>)["tag"] = 42;
    });

    const { code, stderr } = await runChecker(root);
    expect(code).not.toBe(0);
    expect(stderr).toContain("event-payload-invalid");
  });

  it("rejects an event type that no registered schema covers", async () => {
    const root = fixtureRoot();
    editJson(join(root, "examples/events/01-work-item-tag-added.json"), (event) => {
      event["type"] = "scm.work-item.invented";
    });

    const { code, stderr } = await runChecker(root);
    expect(code).not.toBe(0);
    expect(stderr).toContain("event-contract-unregistered");
  });

  it("rejects a manifest whose schemaRef points nowhere", async () => {
    const root = fixtureRoot();
    const path = join(root, "packages/modules/development/module.manifest.yaml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "contracts/events/development.implementation.completed.v1.schema.json",
        "contracts/events/does-not-exist.v1.schema.json",
      ),
    );

    const { code, stderr } = await runChecker(root);
    expect(code).not.toBe(0);
    expect(stderr).toContain("manifest-schemaref-missing");
  });

  it("rejects a project that references an unknown module package", async () => {
    const root = fixtureRoot();
    const path = join(root, "examples/project/.jarvis/project.yaml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "moduleId: jarvis.module.development",
        "moduleId: jarvis.module.invented",
      ),
    );

    const { code, stderr } = await runChecker(root);
    expect(code).not.toBe(0);
    expect(stderr).toContain("project-unknown-module");
  });

  it("rejects a module instance configuration that breaks its module schema", async () => {
    const root = fixtureRoot();
    const path = join(root, "examples/project/.jarvis/project.yaml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("maxRepairCycles: 2", "maxRepairCycles: not-a-number"),
    );

    const { code, stderr } = await runChecker(root);
    expect(code).not.toBe(0);
    expect(stderr).toContain("project-module-config-invalid");
  });

  it("rejects a module instance that drops a configuration its schema requires", async () => {
    const root = fixtureRoot();
    const path = join(root, "examples/project/.jarvis/project.yaml");
    // Deleting the block must not be a way to opt out of rule 7.
    writeFileSync(path, removeYamlBlock(readFileSync(path, "utf8"), "configuration:"));

    const { code, stderr } = await runChecker(root);
    expect(code).not.toBe(0);
    expect(stderr).toContain("project-module-config-invalid");
  });

  it.each([
    [
      "apiVersion",
      "      required: [kind, metadata, repositories, slots, commands, git, workspace, modules]\n",
    ],
    [
      "kind",
      "      required: [apiVersion, metadata, repositories, slots, commands, git, workspace, modules]\n",
    ],
    [
      "repositories",
      "      required: [apiVersion, kind, metadata, slots, commands, git, workspace, modules]\n",
    ],
  ])("rejects Portable Project Configuration parity drift in %s", async (_field, replacement) => {
    const root = fixtureRoot();
    const path = join(root, "contracts/openapi/local-api.v1.yaml");
    const source = readFileSync(path, "utf8");
    writeFileSync(
      path,
      source.replace(
        "      required: [apiVersion, kind, metadata, repositories, slots, commands, git, workspace, modules]\n",
        replacement,
      ),
    );

    const { code, stderr } = await runChecker(root);
    expect(code).not.toBe(0);
    expect(stderr).toContain("project-config-openapi-parity");
  });

  it.each([
    ["apiVersion", "      required: [kind, projectId, repositories, slots]\n"],
    ["kind", "      required: [apiVersion, projectId, repositories, slots]\n"],
    ["repository bindings", "      required: [apiVersion, kind, projectId, slots]\n"],
  ])("rejects Local Bindings parity drift in %s", async (_field, replacement) => {
    const root = fixtureRoot();
    const path = join(root, "contracts/openapi/local-api.v1.yaml");
    const source = readFileSync(path, "utf8");
    writeFileSync(
      path,
      source.replace(
        "      required: [apiVersion, kind, projectId, repositories, slots]\n",
        replacement,
      ),
    );

    const { code, stderr } = await runChecker(root);
    expect(code).not.toBe(0);
    expect(stderr).toContain("project-bindings-openapi-parity");
  });

  it("rejects Local Bindings drift that disallows empty unresolved draft slots", async () => {
    const root = fixtureRoot();
    const path = join(root, "contracts/openapi/local-api.v1.yaml");
    const source = readFileSync(path, "utf8");
    writeFileSync(
      path,
      source.replace(
        '        slots:\n          type: object\n          additionalProperties:\n            $ref: "#/components/schemas/ProjectSlotBinding"\n',
        '        slots:\n          type: object\n          minProperties: 1\n          additionalProperties:\n            $ref: "#/components/schemas/ProjectSlotBinding"\n',
      ),
    );

    const { code, stderr } = await runChecker(root);
    expect(code).not.toBe(0);
    expect(stderr).toContain("project-bindings-openapi-parity");
  });

  it.each([
    [
      "slot binding kind",
      "    ProjectSlotBinding:\n      type: object\n      additionalProperties: false\n      required: [kind, ref]\n      properties:\n        kind:\n          type: string\n          enum: [connection, runtime, mcp]\n",
    ],
    ["slot binding ref", "        ref:\n          type: integer\n"],
    [
      "nullable legacy bookmarkRef",
      "        bookmarkRef:\n          type: string\n          minLength: 1\n",
    ],
  ])("rejects Local Binding component drift in %s", async (field, replacement) => {
    const root = fixtureRoot();
    const path = join(root, "contracts/openapi/local-api.v1.yaml");
    const source = readFileSync(path, "utf8");
    const originals: Record<string, string> = {
      "slot binding kind":
        "    ProjectSlotBinding:\n      type: object\n      additionalProperties: false\n      required: [kind, ref]\n      properties:\n        kind:\n          type: string\n          enum: [connection, runtime, mcp, module-instance, engine]\n",
      "slot binding ref":
        "        ref:\n          type: string\n          minLength: 1\n          maxLength: 300\n",
      "nullable legacy bookmarkRef":
        '        bookmarkRef:\n          type: [string, "null"]\n          minLength: 1\n',
    };
    writeFileSync(path, source.replace(originals[field]!, replacement));

    const { code, stderr } = await runChecker(root);
    expect(code).not.toBe(0);
    expect(stderr).toContain("project-bindings-openapi-parity");
  });

  it("rejects a protected operation that does not document how it refuses callers", async () => {
    const root = fixtureRoot();
    const path = join(root, "contracts/openapi/local-api.v1.yaml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        '        "401":\n          $ref: "#/components/responses/Unauthorized"\n',
        "",
      ),
    );

    const { code, stderr } = await runChecker(root);
    expect(code).not.toBe(0);
    expect(stderr).toContain("openapi-missing-refusal");
  });
});
