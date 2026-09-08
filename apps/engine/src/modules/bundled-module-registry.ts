import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  InvalidModuleConfigurationSchemaError,
  ModuleHost,
  ModuleManifestContractRegistry,
  ModuleManifestDiscoveryError,
  type DiscoveredModuleManifest,
  type ModulePackageRegistry,
} from "../../../../packages/kernel/src/module-host.js";

/** Test-only manifests are folded out of the production engine bundle. */
declare const __JARVIS_TEST_HOOKS__: boolean | undefined;

class BundledModulePackageRegistry implements ModulePackageRegistry {
  public constructor(
    private readonly runtimeRoot: string,
    private readonly packageNames: readonly string[],
  ) {}

  public discover(): readonly DiscoveredModuleManifest[] {
    const bundled = this.packageNames.map((name) => {
      const source = join(this.runtimeRoot, "modules", name, "module.manifest.yaml");
      return {
        packageName: name,
        source,
        get document(): unknown {
          let yaml: string;
          try {
            yaml = readFileSync(source, "utf8");
          } catch {
            throw new ModuleManifestDiscoveryError("/", "Manifest could not be read.");
          }
          try {
            return parseYaml(yaml) as unknown;
          } catch {
            throw new ModuleManifestDiscoveryError("/", "Manifest is not valid YAML.");
          }
        },
      };
    });
    return [...bundled, ...testFixtureManifests()];
  }

  public readConfigurationSchema(schemaRef: string): unknown {
    try {
      return this.readJson(schemaRef);
    } catch {
      throw new InvalidModuleConfigurationSchemaError(
        "Configuration schema could not be read as JSON.",
      );
    }
  }

  public readEventSchema(schemaRef: string): unknown {
    return this.readJson(schemaRef);
  }

  private readJson(schemaRef: string): unknown {
    return JSON.parse(readFileSync(join(this.runtimeRoot, schemaRef), "utf8")) as unknown;
  }
}

function testFixtureManifests(): readonly DiscoveredModuleManifest[] {
  if (!(typeof __JARVIS_TEST_HOOKS__ === "undefined" || __JARVIS_TEST_HOOKS__)) return [];

  return [
    {
      packageName: "test-request-worker",
      source: "<test fixture: request worker>",
      document: {
        apiVersion: "jarvis.dev/module/v1",
        kind: "Module",
        metadata: {
          id: "jarvis.module.test-request-worker",
          version: "1.0.0",
          displayName: "Test Request Worker",
          description: "Deterministic consumer used by the Application Harness.",
          categories: ["automation"],
        },
        runtime: { entrypoint: "dist/index.mjs" },
        contracts: {
          consumes: [
            {
              type: "development.implementation.requested",
              version: 1,
              kind: "request",
              schemaRef: "contracts/events/development.implementation.requested.v1.schema.json",
              handler: "handleImplementationRequested",
            },
            {
              type: "scm.change-request.creation-requested",
              version: 1,
              kind: "request",
              schemaRef: "contracts/events/scm.change-request.creation-requested.v1.schema.json",
              handler: "handleImplementationRequested",
            },
          ],
          produces: [],
        },
        capabilities: {
          requires: [],
          provides: [{ id: "work-items.read" }],
        },
      },
    },
    {
      packageName: "test-sample-probe",
      source: "<test fixture: sample probe>",
      document: {
        apiVersion: "jarvis.dev/module/v1",
        kind: "Module",
        metadata: {
          id: "jarvis.module.sample-probe",
          version: "1.0.0",
          displayName: "Sample Probe",
          description: "Deterministic consumer used by durability tests.",
          categories: ["observer"],
        },
        runtime: { entrypoint: "dist/index.mjs" },
        contracts: {
          consumes: [
            {
              type: "sample.probe.pinged",
              version: 1,
              kind: "fact",
              schemaRef: "contracts/events/sample.probe.pinged.v1.schema.json",
              handler: "handleSampleProbePinged",
            },
          ],
          produces: [
            {
              type: "sample.probe.ponged",
              version: 1,
              kind: "fact",
              schemaRef: "contracts/events/sample.probe.ponged.v1.schema.json",
            },
          ],
        },
        capabilities: { requires: [], provides: [] },
      },
    },
  ];
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
