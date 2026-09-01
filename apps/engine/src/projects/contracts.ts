import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { EngineError } from "../errors.js";

const addFormats = addFormatsModule.default;

const PROJECT_CONFIG_SCHEMA = "contracts/schemas/project-config.v1.schema.json";

/**
 * The project-config JSON Schema under `contracts/` is the source of truth
 * (AGENTS.md invariant 12), so it is read from the contract file, never
 * re-typed here. The file is not bundled: resolve it relative to this module
 * from the two places the engine runs:
 *
 *   - `dist/engine/engine.bundle.mjs` with its self-contained `contracts/` tree
 *   - `apps/engine/src/projects/contracts.ts` (unit tests, development)
 */
const PROJECT_CONFIG_SCHEMA_PATHS = [
  fileURLToPath(new URL(`./${PROJECT_CONFIG_SCHEMA}`, import.meta.url)),
  fileURLToPath(new URL(`../../${PROJECT_CONFIG_SCHEMA}`, import.meta.url)),
  fileURLToPath(new URL(`../../../../${PROJECT_CONFIG_SCHEMA}`, import.meta.url)),
];

let validator: ValidateFunction | undefined;

/**
 * Validates a portable project config against the v1 schema. Errors report the
 * schema paths, never the values: config content belongs to the repository and
 * is not echoed in API responses.
 */
export function validatePortableConfig(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError(
      "project.config-invalid",
      400,
      "The portable config must be a JSON object.",
    );
  }
  const validate = portableConfigValidator();
  if (validate(value)) return;

  const problems = (validate.errors ?? [])
    .map(
      (error) => `${error.instancePath === "" ? "/" : error.instancePath} ${error.message ?? ""}`,
    )
    .join("; ");
  throw new EngineError(
    "project.config-invalid",
    400,
    `The portable config does not satisfy the project-config.v1 schema: ${problems}`,
  );
}

function portableConfigValidator(): ValidateFunction {
  if (validator !== undefined) return validator;

  let schemaJson: string | undefined;
  for (const candidate of PROJECT_CONFIG_SCHEMA_PATHS) {
    if (existsSync(candidate)) {
      try {
        schemaJson = readFileSync(candidate, "utf8");
      } catch {
        /* try the next candidate */
      }
    }
  }
  if (schemaJson === undefined) {
    // A broken installation is the only case that reaches here; the candidates
    // are the engine's own resources, and the operator needs them to fix it.
    try {
      process.stderr.write(
        `jarvis-engine: no readable project-config.v1 schema at: ${PROJECT_CONFIG_SCHEMA_PATHS.join(" , ")}\n`,
      );
    } catch {
      /* the stderr pipe is gone; the 500 below still names the problem */
    }
    throw new EngineError(
      "system.internal-error",
      500,
      "The portable config could not be validated: the project-config.v1 schema is missing.",
    );
  }

  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  validator = ajv.compile(JSON.parse(schemaJson) as object);
  return validator;
}
