import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import type { ModuleHost } from "../../../../packages/kernel/src/module-host.js";
import type {
  ProjectBindings,
  PortableProjectConfiguration,
} from "../../../../packages/project-runtime/src/project-types.js";
import { EngineError, type ErrorCode } from "../errors.js";

const addFormats = addFormatsModule.default;
const CONTRACT_PATHS = (name: string): readonly string[] => [
  fileURLToPath(new URL(`./contracts/schemas/${name}`, import.meta.url)),
  fileURLToPath(new URL(`../../contracts/schemas/${name}`, import.meta.url)),
  fileURLToPath(new URL(`../../../../contracts/schemas/${name}`, import.meta.url)),
];

let projectValidator: ValidateFunction | undefined;
let bindingsValidator: ValidateFunction | undefined;

/** Schema-only validation retained for adopting an explicitly supplied import. */
export function validatePortableConfig(value: unknown): void {
  requireObject(value, "project.config-invalid", "The portable config must be a JSON object.");
  requireValid(projectConfigValidator(), value, "project.config-invalid", "portable config");
}

/** Full replacement validation: machine schema plus Project Runtime invariants. */
export function requirePortableProjectConfiguration(
  value: unknown,
  modules: ModuleHost,
): PortableProjectConfiguration {
  validatePortableConfig(value);
  const config = value as PortableProjectConfiguration;
  if (config.repositories.length !== 1 || config.repositories[0]?.id !== "main") {
    invalid("/repositories must contain exactly one repository with id main");
  }

  const instanceIds = new Set<string>();
  const slots = new Set(Object.keys(config.slots));
  const repositories = new Set(config.repositories.map((repository) => repository.id));
  for (const [index, instance] of config.modules.entries()) {
    const base = `/modules/${index}`;
    if (instanceIds.has(instance.instanceId)) invalid(`${base}/instanceId must be unique`);
    instanceIds.add(instance.instanceId);

    if (modules.package(instance.moduleId) === undefined) {
      invalid(`${base}/moduleId is not an accepted bundled Module Package`);
    }
    const validation = modules.validateConfiguration(
      instance.moduleId,
      instance.configuration ?? {},
    );
    if (!validation.valid) {
      invalid(validation.issues.map((issue) => `${base}/configuration${issue}`).join("; "));
    }
    if (instance.runtimeSlot !== undefined && !slots.has(instance.runtimeSlot)) {
      invalid(`${base}/runtimeSlot must reference a declared Project slot`);
    }
    for (const [bindingName, reference] of Object.entries(instance.bindings ?? {})) {
      if (!slots.has(reference) && !repositories.has(reference)) {
        invalid(
          `${base}/bindings/${bindingName} must reference a declared Project slot or repository`,
        );
      }
    }
  }
  return config;
}

export function requireProjectBindings(value: unknown): ProjectBindings {
  requireObject(value, "project.bindings-invalid", "Local Bindings must be a JSON object.");
  requireValid(bindingsContractValidator(), value, "project.bindings-invalid", "Local Bindings");
  return value as unknown as ProjectBindings;
}

function requireObject(
  value: unknown,
  code: ErrorCode,
  message: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError(code, 400, message);
  }
}

function requireValid(
  validate: ValidateFunction,
  value: unknown,
  code: ErrorCode,
  subject: string,
): void {
  if (validate(value)) return;
  const problems = (validate.errors ?? [])
    .map(
      (error) => `${error.instancePath === "" ? "/" : error.instancePath} ${error.message ?? ""}`,
    )
    .join("; ");
  throw new EngineError(code, 400, `The ${subject} does not satisfy its v1 schema: ${problems}`);
}

function invalid(problem: string): never {
  throw new EngineError(
    "project.config-invalid",
    400,
    `The portable config violates Project Runtime invariants: ${problem}`,
  );
}

function projectConfigValidator(): ValidateFunction {
  return (projectValidator ??= compileContract("project-config.v1.schema.json"));
}

function bindingsContractValidator(): ValidateFunction {
  return (bindingsValidator ??= compileContract("project-bindings.v1.schema.json"));
}

function compileContract(name: string): ValidateFunction {
  let schemaJson: string | undefined;
  for (const candidate of CONTRACT_PATHS(name)) {
    if (!existsSync(candidate)) continue;
    try {
      schemaJson = readFileSync(candidate, "utf8");
      break;
    } catch {
      // Try the next bundle/development location.
    }
  }
  if (schemaJson === undefined) {
    throw new EngineError(
      "system.internal-error",
      500,
      `Project configuration could not be validated: ${name} is missing.`,
    );
  }
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(JSON.parse(schemaJson) as object);
}
