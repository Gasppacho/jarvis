#!/usr/bin/env node
/**
 * `pnpm contracts:check` — the gate described in docs/engineering/CONTRACT_VALIDATION.md.
 * Contracts are the source of truth, so every example must prove it.
 */
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// Overridable so the suite can point the gate at mutated fixtures and prove
// every rule actually bites.
const repoRoot = process.env.JARVIS_CONTRACTS_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
const failures = [];

function fail(rule, where, detail) {
  failures.push({ rule, where, detail });
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readYaml = (path) => parseYaml(readFileSync(path, "utf8"));
const rel = (path) => path.slice(repoRoot.length);

const listFiles = (dir, suffix) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(suffix))
        .sort()
        .map((name) => join(dir, name))
    : [];

const listBundledModuleManifests = () => {
  const modulesDir = join(repoRoot, "packages/modules");
  if (!existsSync(modulesDir)) return [];
  return readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(modulesDir, entry.name, "module.manifest.yaml"))
    .filter(existsSync)
    .sort();
};

const ajv = new Ajv2020({
  strict: true,
  // `required` inside an if/then branch names properties defined in the parent
  // schema. That is valid 2020-12; Ajv's strictRequired flags it anyway.
  strictRequired: false,
  allErrors: true,
  allowUnionTypes: true,
});
addFormats(ajv);

const errorText = (validate) =>
  (validate.errors ?? [])
    .map((e) => `${e.instancePath === "" ? "/" : e.instancePath} ${e.message ?? ""}`)
    .join("; ");

// ---------------------------------------------------------------- 1. schemas
const schemaDirs = ["contracts/schemas", "contracts/events", "contracts/module-config"];
const compiled = new Map();

for (const dir of schemaDirs) {
  for (const file of listFiles(join(repoRoot, dir), ".schema.json")) {
    const schema = readJson(file);
    if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      fail("schema-draft", rel(file), `expected JSON Schema 2020-12, got ${schema.$schema}`);
      continue;
    }
    try {
      compiled.set(rel(file).replace(/^\//, ""), ajv.compile(schema));
    } catch (error) {
      fail("schema-invalid", rel(file), String(error));
    }
  }
}

const envelopeKey = "contracts/schemas/event-envelope.v1.schema.json";
const validateEnvelope = compiled.get(envelopeKey);
if (validateEnvelope === undefined) fail("schema-missing", envelopeKey, "envelope schema absent");

// ------------------------------------------------ 2 & 3. event examples
for (const file of listFiles(join(repoRoot, "examples/events"), ".json")) {
  const event = readJson(file);

  if (validateEnvelope !== undefined && !validateEnvelope(event)) {
    fail("event-envelope-invalid", rel(file), errorText(validateEnvelope));
    continue;
  }

  const payloadKey = `contracts/events/${event.type}.v${event.version}.schema.json`;
  const validatePayload = compiled.get(payloadKey);
  if (validatePayload === undefined) {
    fail(
      "event-contract-unregistered",
      rel(file),
      `no schema for (${event.type}, v${event.version})`,
    );
  } else if (!validatePayload(event.payload)) {
    fail("event-payload-invalid", rel(file), errorText(validatePayload));
  }
}

// ------------------------------------------------ 4, 5 & 8. module manifests
const validateManifest = compiled.get("contracts/schemas/module-manifest.v1.schema.json");
const manifestsById = new Map();

const moduleManifestFiles = [
  ...listBundledModuleManifests(),
  ...listFiles(join(repoRoot, "examples/modules"), ".module.yaml"),
];
for (const file of moduleManifestFiles) {
  const manifest = readYaml(file);

  if (validateManifest !== undefined && !validateManifest(manifest)) {
    fail("manifest-invalid", rel(file), errorText(validateManifest));
    continue;
  }
  manifestsById.set(manifest.metadata.id, manifest);

  const declared = [
    ...(manifest.contracts?.consumes ?? []),
    ...(manifest.contracts?.produces ?? []),
  ];
  for (const contract of declared) {
    // 5. every schemaRef resolves to a file that exists.
    if (contract.schemaRef !== undefined && !existsSync(join(repoRoot, contract.schemaRef))) {
      fail("manifest-schemaref-missing", rel(file), `${contract.type}: ${contract.schemaRef}`);
    }
    // 8. no producer/consumer without a registered event contract.
    const key = `contracts/events/${contract.type}.v${contract.version}.schema.json`;
    if (!compiled.has(key)) {
      fail(
        "manifest-contract-unregistered",
        rel(file),
        `${contract.type} v${contract.version} has no registered schema`,
      );
    }
  }

  const configRef = manifest.configuration?.schemaRef;
  if (configRef !== undefined && !existsSync(join(repoRoot, configRef))) {
    fail("manifest-config-schema-missing", rel(file), configRef);
  }
}

// ------------------------------------------- 6, 7 & 9. project examples
const projectFile = join(repoRoot, "examples/project/.jarvis/project.yaml");
if (existsSync(projectFile)) {
  const project = readYaml(projectFile);
  const validateProject = compiled.get("contracts/schemas/project-config.v1.schema.json");

  if (validateProject !== undefined && !validateProject(project)) {
    fail("project-config-invalid", rel(projectFile), errorText(validateProject));
  }

  for (const instance of project.modules ?? []) {
    const manifest = manifestsById.get(instance.moduleId);
    // 9. an example project may only reference a known Module Package.
    if (manifest === undefined) {
      fail(
        "project-unknown-module",
        rel(projectFile),
        `unknown module package ${instance.moduleId}`,
      );
      continue;
    }
    // 7. the instance configuration must satisfy its module's schema.
    const configRef = manifest.configuration?.schemaRef;
    if (configRef === undefined) continue;
    // A missing `configuration:` block is not a free pass: an empty object must
    // still satisfy the module schema, which is where required keys are caught.
    const configuration = instance.configuration ?? {};
    const validateConfig = compiled.get(configRef);
    if (validateConfig === undefined) {
      fail("project-module-config-schema-missing", rel(projectFile), configRef);
    } else if (!validateConfig(configuration)) {
      fail(
        "project-module-config-invalid",
        `${rel(projectFile)}#${instance.instanceId}`,
        errorText(validateConfig),
      );
    }
  }
}

const bindingsFile = join(repoRoot, "examples/project/local-bindings.yaml");
if (existsSync(bindingsFile)) {
  const validateBindings = compiled.get("contracts/schemas/project-bindings.v1.schema.json");
  const bindings = readYaml(bindingsFile);
  if (validateBindings !== undefined && !validateBindings(bindings)) {
    fail("project-bindings-invalid", rel(bindingsFile), errorText(validateBindings));
  }
}

// ------------------------------------------------------------- 10. OpenAPI
const openApiFile = join(repoRoot, "contracts/openapi/local-api.v1.yaml");
const openApi = readYaml(openApiFile);
const METHODS = ["get", "put", "post", "delete", "patch"];

function dereferenceOpenApiSchema(value, seen = new Set()) {
  if (Array.isArray(value)) return value.map((item) => dereferenceOpenApiSchema(item, seen));
  if (typeof value !== "object" || value === null) return value;
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/components/schemas/")) {
    const name = value.$ref.slice("#/components/schemas/".length);
    if (seen.has(name)) throw new Error(`cyclic OpenAPI schema reference ${value.$ref}`);
    const target = openApi.components?.schemas?.[name];
    if (target === undefined) throw new Error(`missing OpenAPI schema reference ${value.$ref}`);
    return dereferenceOpenApiSchema(target, new Set([...seen, name]));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, dereferenceOpenApiSchema(child, seen)]),
  );
}

function normalizedContractSchema(value) {
  if (Array.isArray(value)) return value.map(normalizedContractSchema);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["$schema", "$id", "title"].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizedContractSchema(child)]),
  );
}

function enforceOpenApiParity({ componentName, schemaKey, example, parityRule, exampleRule }) {
  const component = openApi.components?.schemas?.[componentName];
  const schemaPath = join(repoRoot, schemaKey);
  if (component === undefined) {
    fail(parityRule, rel(openApiFile), `components.schemas.${componentName} is absent`);
    return;
  }

  let resolved;
  try {
    resolved = dereferenceOpenApiSchema(component);
  } catch (error) {
    fail(parityRule, rel(openApiFile), String(error));
    return;
  }
  const jsonSchema = readJson(schemaPath);
  if (
    JSON.stringify(normalizedContractSchema(resolved)) !==
    JSON.stringify(normalizedContractSchema(jsonSchema))
  ) {
    fail(
      parityRule,
      rel(openApiFile),
      `components.schemas.${componentName} differs from ${schemaKey}`,
    );
  }

  try {
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(resolved);
    if (!validate(example)) fail(exampleRule, rel(openApiFile), errorText(validate));
  } catch (error) {
    fail(parityRule, rel(openApiFile), `components.schemas.${componentName}: ${String(error)}`);
  }
}

if (existsSync(projectFile)) {
  enforceOpenApiParity({
    componentName: "PortableProjectConfiguration",
    schemaKey: "contracts/schemas/project-config.v1.schema.json",
    example: readYaml(projectFile),
    parityRule: "project-config-openapi-parity",
    exampleRule: "project-config-openapi-invalid",
  });
}
if (existsSync(bindingsFile)) {
  enforceOpenApiParity({
    componentName: "ProjectBindings",
    schemaKey: "contracts/schemas/project-bindings.v1.schema.json",
    example: readYaml(bindingsFile),
    parityRule: "project-bindings-openapi-parity",
    exampleRule: "project-bindings-openapi-invalid",
  });
}

if (openApi.openapi === undefined || !String(openApi.openapi).startsWith("3.1")) {
  fail("openapi-version", rel(openApiFile), `expected OpenAPI 3.1, got ${openApi.openapi}`);
}

const globallySecured = Array.isArray(openApi.security) && openApi.security.length > 0;
for (const [path, item] of Object.entries(openApi.paths ?? {})) {
  for (const method of METHODS) {
    const operation = item[method];
    if (operation === undefined) continue;

    const where = `${method.toUpperCase()} ${path}`;
    if (operation.operationId === undefined) {
      fail("openapi-operation-id", rel(openApiFile), `${where} has no operationId`);
    }

    const secured = globallySecured || Array.isArray(operation.security);
    // The engine answers only authenticated loopback callers, so every protected
    // operation must document how it refuses the other two cases.
    if (secured) {
      for (const status of ["401", "403"]) {
        if (operation.responses?.[status] === undefined) {
          fail("openapi-missing-refusal", rel(openApiFile), `${where} does not declare ${status}`);
        }
      }
    }
  }
}

for (const name of ["Unauthorized", "Forbidden", "Error"]) {
  if (openApi.components?.responses?.[name] === undefined) {
    fail("openapi-missing-response", rel(openApiFile), `components.responses.${name} is absent`);
  }
}

// ------------------------------------------------------------------ report
if (failures.length > 0) {
  for (const { rule, where, detail } of failures) {
    process.stderr.write(`✗ [${rule}] ${where}\n    ${detail}\n`);
  }
  process.stderr.write(`\n${failures.length} contract violation(s).\n`);
  process.exit(1);
}

const counts = [
  `${compiled.size} schemas`,
  `${listFiles(join(repoRoot, "examples/events"), ".json").length} event examples`,
  `${manifestsById.size} manifests`,
  `${Object.keys(openApi.paths ?? {}).length} API paths`,
];
process.stdout.write(`contracts ok — ${counts.join(", ")}\n`);
