import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";

const addFormats = addFormatsModule.default;
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DOCUMENT_ID = "https://jarvis.dev/local-api.v1";

/**
 * Assertions run against contracts/openapi/local-api.v1.yaml itself, so a
 * response that drifts from the published contract fails the test rather than
 * quietly passing a hand-copied expectation.
 */
const ajv = (() => {
  const document = parseYaml(
    readFileSync(join(REPO_ROOT, "contracts/openapi/local-api.v1.yaml"), "utf8"),
  ) as Record<string, unknown>;
  const instance = new Ajv2020({ strict: false, allErrors: true });
  addFormats(instance);
  // The whole document is registered so intra-document $refs (ProjectDetail's
  // allOf on ProjectSummary, for one) resolve.
  instance.addSchema({ $id: DOCUMENT_ID, ...document });
  return instance;
})();

export function localApiValidator(schemaName: string): ValidateFunction {
  const validate = ajv.getSchema(`${DOCUMENT_ID}#/components/schemas/${schemaName}`);
  if (validate === undefined) {
    throw new Error(`the Local API contract declares no schema named ${schemaName}`);
  }
  return validate;
}

/** Formats Ajv errors for a readable assertion message. */
export function explain(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`.trim())
    .join("; ");
}
