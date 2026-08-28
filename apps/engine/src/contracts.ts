import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Versioned contracts ship beside the engine bundle
 * (`dist/engine/contracts`, see docs/architecture/TECHNOLOGY_STACK.md). When the
 * engine runs from source, the repository copy is the same source of truth.
 */
const BUNDLED = new URL("./contracts/", import.meta.url);
const IN_REPOSITORY = new URL("../../../contracts/", import.meta.url);

export const CONTRACTS_DIR = existsSync(fileURLToPath(BUNDLED))
  ? BUNDLED
  : IN_REPOSITORY;

export function readContract(relativePath: string): object {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(relativePath, CONTRACTS_DIR)), "utf8"),
  ) as object;
}
