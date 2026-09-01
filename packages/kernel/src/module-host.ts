import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

export interface ModuleCatalogEntry {
  readonly moduleId: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly categories: readonly string[];
  readonly consumes: readonly string[];
  readonly produces: readonly string[];
  readonly requires: readonly string[];
  readonly provides: readonly string[];
  readonly configurationSchemaRef: string | null;
  readonly configurationSchema: Readonly<Record<string, unknown>> | null;
}

interface ContractDescriptor {
  readonly type: string;
  readonly version: number;
}

interface CapabilityDescriptor {
  readonly id: string;
}

interface ModuleManifest {
  readonly metadata: {
    readonly id: string;
    readonly version: string;
    readonly displayName: string;
    readonly description: string;
    readonly categories: readonly string[];
  };
  readonly contracts: {
    readonly consumes: readonly ContractDescriptor[];
    readonly produces: readonly ContractDescriptor[];
  };
  readonly capabilities: {
    readonly requires: readonly CapabilityDescriptor[];
    readonly provides: readonly CapabilityDescriptor[];
  };
  readonly configuration?: {
    readonly schemaRef: string;
  };
}

export interface DiscoveredModuleManifest {
  readonly source: string;
  readonly document: unknown;
}

/** Filesystem-backed discovery is an adapter injected through this port. */
export interface ModulePackageRegistry {
  discover(): readonly DiscoveredModuleManifest[];
  readConfigurationSchema(schemaRef: string): unknown;
}

export class InvalidModuleConfigurationSchemaError extends Error {
  public constructor() {
    super("A Module configuration schema must be a JSON object.");
    this.name = "InvalidModuleConfigurationSchemaError";
  }
}

export class InvalidModuleManifestError extends Error {
  public constructor(
    public readonly source: string,
    public readonly issues: readonly string[],
  ) {
    super(`Invalid Module Manifest ${source}: ${issues.join("; ")}`);
    this.name = "InvalidModuleManifestError";
  }
}

/** Kernel service that owns validation of registered versioned contracts. */
export class ModuleManifestContractRegistry {
  private readonly validateModuleManifestV1: ValidateFunction<ModuleManifest>;

  public constructor(contracts: { readonly moduleManifestV1: object }) {
    this.validateModuleManifestV1 = new Ajv2020({
      strict: true,
      strictRequired: false,
      allErrors: true,
    }).compile<ModuleManifest>(contracts.moduleManifestV1);
  }

  public requireModuleManifestV1(candidate: DiscoveredModuleManifest): ModuleManifest {
    if (this.validateModuleManifestV1(candidate.document)) return candidate.document;

    const issues = (this.validateModuleManifestV1.errors ?? []).map(
      (error) =>
        `${error.instancePath === "" ? "/" : error.instancePath} ${error.message ?? "is invalid"}`,
    );
    throw new InvalidModuleManifestError(candidate.source, issues);
  }
}

/**
 * Kernel Module Host for official packages registered in the engine bundle.
 * It consumes declarative Manifests only; concrete module code remains on the
 * other side of the Module SDK boundary.
 */
export class ModuleHost {
  private readonly entries: readonly ModuleCatalogEntry[];

  public constructor(registry: ModulePackageRegistry, contracts: ModuleManifestContractRegistry) {
    this.entries = registry
      .discover()
      .map((candidate) => contracts.requireModuleManifestV1(candidate))
      .map((manifest) => toCatalogEntry(manifest, registry));
  }

  public catalog(): readonly ModuleCatalogEntry[] {
    return this.entries;
  }
}

function toCatalogEntry(
  manifest: ModuleManifest,
  registry: ModulePackageRegistry,
): ModuleCatalogEntry {
  const eventId = (descriptor: ContractDescriptor): string =>
    `${descriptor.type}.v${descriptor.version}`;
  const configurationSchemaRef = manifest.configuration?.schemaRef ?? null;
  const configurationSchema =
    configurationSchemaRef === null
      ? null
      : requireJsonObject(registry.readConfigurationSchema(configurationSchemaRef));

  return {
    moduleId: manifest.metadata.id,
    version: manifest.metadata.version,
    displayName: manifest.metadata.displayName,
    description: manifest.metadata.description,
    categories: manifest.metadata.categories,
    consumes: manifest.contracts.consumes.map(eventId),
    produces: manifest.contracts.produces.map(eventId),
    requires: manifest.capabilities.requires.map((capability) => capability.id),
    provides: manifest.capabilities.provides.map((capability) => capability.id),
    configurationSchemaRef,
    configurationSchema,
  };
}

function requireJsonObject(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidModuleConfigurationSchemaError();
  }
  return value as Readonly<Record<string, unknown>>;
}
