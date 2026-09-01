import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ModuleHost,
  ModuleManifestContractRegistry,
  type DiscoveredModuleManifest,
  type ModulePackageRegistry,
} from "../../../../packages/kernel/src/module-host.js";

class BundledModulePackageRegistry implements ModulePackageRegistry {
  public constructor(
    private readonly runtimeRoot: string,
    private readonly packageNames: readonly string[],
  ) {}

  public discover(): readonly DiscoveredModuleManifest[] {
    return this.packageNames.map((name) => {
      const source = join(this.runtimeRoot, "modules", name, "module.manifest.yaml");
      return {
        source,
        document: parseYaml(readFileSync(source, "utf8")) as unknown,
      };
    });
  }

  public readConfigurationSchema(schemaRef: string): unknown {
    return JSON.parse(readFileSync(join(this.runtimeRoot, schemaRef), "utf8")) as unknown;
  }
}

/** Composition adapter for the explicit build-time registry beside the engine. */
export function loadBundledModuleHost(runtimeRoot: string): ModuleHost {
  const schemaPath = join(runtimeRoot, "contracts", "schemas", "module-manifest.v1.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;
  const registryDocument = JSON.parse(
    readFileSync(join(runtimeRoot, "module-registry.json"), "utf8"),
  ) as unknown;
  const packageNames = requirePackageNames(registryDocument);

  return new ModuleHost(
    new BundledModulePackageRegistry(runtimeRoot, packageNames),
    new ModuleManifestContractRegistry({ moduleManifestV1: schema }),
  );
}

function requirePackageNames(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null || !("packages" in value)) {
    throw new Error("The bundled Module Package registry is invalid.");
  }
  const packages = (value as { readonly packages: unknown }).packages;
  if (!Array.isArray(packages) || !packages.every((name) => typeof name === "string")) {
    throw new Error("The bundled Module Package registry must list package names.");
  }
  return packages;
}
