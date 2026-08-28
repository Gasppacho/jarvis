/**
 * Implements docs/engineering/CONTRACT_VALIDATION.md "Required checks".
 * Contracts are executable, not decorative: this is the gate that keeps
 * schemas, examples, manifests, OpenAPI and generated code in step.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { parse as parseYaml } from "yaml";

const addFormats = addFormatsModule.default;
import { GENERATED_TYPES, renderLocalApiTypes } from "./generate.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const failures: string[] = [];

const fail = (label: string, detail: string): void => {
  failures.push(`${label}: ${detail}`);
};

const readJson = (relative: string): unknown =>
  JSON.parse(readFileSync(join(REPO_ROOT, relative), "utf8"));
const readYaml = (relative: string): unknown =>
  parseYaml(readFileSync(join(REPO_ROOT, relative), "utf8"));

function listFiles(relativeDir: string, suffix: string): string[] {
  return readdirSync(join(REPO_ROOT, relativeDir))
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => `${relativeDir}/${name}`);
}

/** A fresh Ajv per schema keeps `$id` collisions out of the way. */
function check(instance: unknown, schema: object, label: string): void {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (validate(instance)) return;
  for (const error of validate.errors ?? []) {
    fail(
      label,
      `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
    );
  }
}

// 1. Every JSON Schema is itself a valid Draft 2020-12 schema.
function checkSchemas(): string[] {
  const schemaPaths: string[] = [];
  for (const dir of [
    "contracts/schemas",
    "contracts/events",
    "contracts/module-config",
  ]) {
    schemaPaths.push(...listFiles(dir, ".schema.json"));
  }
  for (const path of schemaPaths) {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    try {
      ajv.compile(readJson(path) as object);
    } catch (error) {
      fail(
        path,
        `invalid schema: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return schemaPaths;
}

// 2 + 3. Each example validates against the envelope and its payload schema.
function checkEvents(): void {
  const envelope = readJson(
    "contracts/schemas/event-envelope.v1.schema.json",
  ) as object;
  for (const path of listFiles("examples/events", ".json")) {
    const event = readJson(path) as {
      type: string;
      version: number;
      payload: unknown;
    };
    check(event, envelope, path);

    const payloadSchema = `contracts/events/${event.type}.v${event.version}.schema.json`;
    if (!existsSync(join(REPO_ROOT, payloadSchema))) {
      fail(path, `missing payload schema ${payloadSchema}`);
      continue;
    }
    check(event.payload, readJson(payloadSchema) as object, `${path} payload`);
  }
}

interface Manifest {
  metadata: { id: string };
  contracts: { consumes: Descriptor[]; produces: Descriptor[] };
  configuration?: { schemaRef: string };
  permissions?: { emit?: string[] };
}
interface Descriptor {
  type: string;
  version: number;
  schemaRef: string;
}

// 4 + 5 + 8. Manifests validate, their schemaRefs exist, and every emitted
// type is actually declared as a produced contract.
function checkManifests(): Map<string, Manifest> {
  const manifestSchema = readJson(
    "contracts/schemas/module-manifest.v1.schema.json",
  ) as object;
  const manifests = new Map<string, Manifest>();

  for (const path of listFiles("examples/modules", ".yaml")) {
    const manifest = readYaml(path) as Manifest;
    check(manifest, manifestSchema, path);
    manifests.set(manifest.metadata.id, manifest);

    const refs = [
      ...manifest.contracts.consumes,
      ...manifest.contracts.produces,
    ].map((descriptor) => descriptor.schemaRef);
    if (manifest.configuration) refs.push(manifest.configuration.schemaRef);
    for (const ref of refs) {
      if (!existsSync(join(REPO_ROOT, ref)))
        fail(path, `missing schemaRef ${ref}`);
    }

    const produced = new Set(
      manifest.contracts.produces.map((descriptor) => descriptor.type),
    );
    for (const emitted of manifest.permissions?.emit ?? []) {
      if (!produced.has(emitted)) {
        fail(
          path,
          `permissions.emit declares ${emitted} but no produced contract does`,
        );
      }
    }
  }
  return manifests;
}

// 6 + 7 + 9. The example project, its bindings, and each module instance
// configuration validate against the schemas their manifest points at.
function checkProject(manifests: Map<string, Manifest>): void {
  const project = readYaml("examples/project/.jarvis/project.yaml") as {
    modules: {
      instanceId: string;
      moduleId: string;
      configuration?: unknown;
    }[];
  };
  check(
    project,
    readJson("contracts/schemas/project-config.v1.schema.json") as object,
    "examples/project/.jarvis/project.yaml",
  );
  check(
    readYaml("examples/project/local-bindings.yaml"),
    readJson("contracts/schemas/project-bindings.v1.schema.json") as object,
    "examples/project/local-bindings.yaml",
  );

  for (const instance of project.modules) {
    const manifest = manifests.get(instance.moduleId);
    if (manifest === undefined) {
      fail(
        "examples/project/.jarvis/project.yaml",
        `unknown Module Package ${instance.moduleId}`,
      );
      continue;
    }
    if (manifest.configuration) {
      check(
        instance.configuration ?? {},
        readJson(manifest.configuration.schemaRef) as object,
        `module instance ${instance.instanceId} configuration`,
      );
    }
  }
}

// 10a. OpenAPI is 3.1 and every internal reference resolves.
function checkOpenApi(): void {
  const label = "contracts/openapi/local-api.v1.yaml";
  const document = readYaml(label) as Record<string, unknown>;

  if (!String(document.openapi ?? "").startsWith("3.1"))
    fail(label, "document is not OpenAPI 3.1");
  if (!document.paths || !document.components)
    fail(label, "document is missing paths or components");

  const refs: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key === "$ref" && typeof child === "string") refs.push(child);
        else walk(child);
      }
    }
  };
  walk(document);

  for (const ref of refs.filter((candidate) => candidate.startsWith("#/"))) {
    let cursor: unknown = document;
    for (const rawPart of ref.slice(2).split("/")) {
      const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
      if (cursor === null || typeof cursor !== "object" || !(part in cursor)) {
        fail(label, `unresolved reference ${ref}`);
        break;
      }
      cursor = (cursor as Record<string, unknown>)[part];
    }
  }
}

// 10b. Generated output is committed and current.
async function checkGeneratedOutput(): Promise<void> {
  const target = fileURLToPath(GENERATED_TYPES);
  if (!existsSync(target)) {
    fail(
      "apps/engine/src/api/generated/local-api.ts",
      "missing — run `pnpm generate`",
    );
    return;
  }
  if (readFileSync(target, "utf8") !== (await renderLocalApiTypes())) {
    fail(
      "apps/engine/src/api/generated/local-api.ts",
      "is stale against contracts/openapi/local-api.v1.yaml — run `pnpm generate`",
    );
  }
}

const schemaPaths = checkSchemas();
checkEvents();
checkProject(checkManifests());
checkOpenApi();
await checkGeneratedOutput();

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.stderr.write(`\n${failures.length} contract failure(s)\n`);
  process.exit(1);
}
process.stderr.write(
  `contracts ok: ${schemaPaths.length} schemas, ${listFiles("examples/events", ".json").length} event examples, ${listFiles("examples/modules", ".yaml").length} manifests\n`,
);
