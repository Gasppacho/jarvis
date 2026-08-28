/**
 * Generates the engine's TypeScript view of the Local API.
 * contracts/openapi/local-api.v1.yaml stays the single source of truth:
 * docs/architecture/TECHNOLOGY_STACK.md forbids a second hand-written DTO layer.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";

const REPO_ROOT = new URL("../", import.meta.url);
export const OPENAPI_SOURCE = new URL(
  "contracts/openapi/local-api.v1.yaml",
  REPO_ROOT,
);
export const GENERATED_TYPES = new URL(
  "apps/engine/src/api/generated/local-api.ts",
  REPO_ROOT,
);

const BANNER = `/**
 * GENERATED FILE — DO NOT EDIT.
 * Source: contracts/openapi/local-api.v1.yaml
 * Regenerate with: pnpm generate
 */

`;

export async function renderLocalApiTypes(): Promise<string> {
  return BANNER + astToString(await openapiTS(OPENAPI_SOURCE));
}

async function main(): Promise<void> {
  const contents = await renderLocalApiTypes();
  const target = fileURLToPath(GENERATED_TYPES);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
  process.stderr.write(`generated ${target}\n`);
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
