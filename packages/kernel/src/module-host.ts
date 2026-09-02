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

interface ContractDescriptorBase {
  readonly type: string;
  readonly version: number;
  readonly schemaRef: string;
}

interface ModuleConsumedContractDescriptor extends ContractDescriptorBase {
  readonly kind: "request" | "fact";
}

export type ModuleContractDescriptor = ContractDescriptorBase &
  (
    | {
        readonly kind: "request";
        readonly targeting?: { readonly configurationPath: string };
      }
    | {
        readonly kind: "fact";
        readonly targeting?: never;
      }
  );

interface ModuleCapabilityRequirementBase {
  readonly id: string;
  readonly optional?: boolean;
}

export type ModuleCapabilityRequirement =
  | (ModuleCapabilityRequirementBase & {
      readonly binding?: string;
      readonly resolution?: undefined;
    })
  | (ModuleCapabilityRequirementBase & {
      readonly binding?: string;
      readonly resolution: { readonly kind: "engine"; readonly ref: string };
    })
  | (ModuleCapabilityRequirementBase & {
      readonly binding: string;
      readonly resolution: { readonly kind: "project-repository" };
    });

export interface ModuleRequestTarget {
  readonly moduleInstanceId?: string;
  readonly binding?: string;
}

interface CapabilityDescriptor {
  readonly id: string;
}

export interface ModuleCompositionMetadata {
  readonly consumes: readonly ModuleConsumedContractDescriptor[];
  readonly produces: readonly ModuleContractDescriptor[];
  readonly requires: readonly ModuleCapabilityRequirement[];
  readonly provides: readonly string[];
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
    readonly consumes: readonly ModuleConsumedContractDescriptor[];
    readonly produces: readonly ModuleContractDescriptor[];
  };
  readonly capabilities: {
    readonly requires: readonly ModuleCapabilityRequirement[];
    readonly provides: readonly CapabilityDescriptor[];
  };
  readonly configuration?: {
    readonly schemaRef: string;
  };
}

export interface DiscoveredModuleManifest {
  readonly packageName: string;
  readonly source: string;
  readonly document: unknown;
}

export interface ModuleCatalogDiagnostic {
  readonly packageName: string;
  readonly issues: readonly string[];
}

export interface ModuleConfigurationValidation {
  readonly valid: boolean;
  /** JSON Pointer paths and schema messages only; configuration values are never echoed. */
  readonly issues: readonly string[];
  /** Stable JSON Pointer target for each issue at the same index. */
  readonly fields: readonly string[];
}

/** Filesystem-backed discovery is an adapter injected through this port. */
export interface ModulePackageRegistry {
  discover(): readonly DiscoveredModuleManifest[];
  readConfigurationSchema(schemaRef: string): unknown;
}

export class ModuleManifestDiscoveryError extends Error {
  public constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(reason);
    this.name = "ModuleManifestDiscoveryError";
  }
}

export class InvalidModuleConfigurationSchemaError extends Error {
  public readonly path = "/configuration/schemaRef";

  public constructor(public readonly reason: string) {
    super(reason);
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
    const document = candidate.document;
    if (!this.validateModuleManifestV1(document)) {
      const issues = (this.validateModuleManifestV1.errors ?? []).map(
        (error) =>
          `${error.instancePath === "" ? "/" : error.instancePath} ${error.message ?? "is invalid"}`,
      );
      throw new InvalidModuleManifestError(candidate.source, issues);
    }

    const issues = contractSchemaRefIssues(document);
    if (issues.length > 0) throw new InvalidModuleManifestError(candidate.source, issues);
    return document;
  }
}

/**
 * Kernel Module Host for official packages registered in the engine bundle.
 * It consumes declarative Manifests only; concrete module code remains on the
 * other side of the Module SDK boundary.
 */
export class ModuleHost {
  private readonly entries: ModuleCatalogEntry[] = [];
  private readonly entriesById = new Map<string, ModuleCatalogEntry>();
  private readonly compositionById = new Map<string, ModuleCompositionMetadata>();
  private readonly configurationValidators = new Map<string, ValidateFunction>();
  private readonly rejected: ModuleCatalogDiagnostic[] = [];

  public constructor(registry: ModulePackageRegistry, contracts: ModuleManifestContractRegistry) {
    for (const candidate of registry.discover()) {
      try {
        const manifest = contracts.requireModuleManifestV1(candidate);
        const entry = toCatalogEntry(manifest, registry);
        const validator = configurationValidator(entry.configurationSchema);
        this.entries.push(entry);
        this.entriesById.set(entry.moduleId, entry);
        this.compositionById.set(manifest.metadata.id, {
          consumes: manifest.contracts.consumes,
          produces: manifest.contracts.produces,
          requires: manifest.capabilities.requires,
          provides: manifest.capabilities.provides.map((capability) => capability.id),
        });
        if (validator !== undefined) this.configurationValidators.set(entry.moduleId, validator);
      } catch (error) {
        this.rejected.push(toDiagnostic(candidate, error));
      }
    }
  }

  public catalog(): readonly ModuleCatalogEntry[] {
    return this.entries;
  }

  /** Only successfully validated bundled packages are addressable by projects. */
  public package(moduleId: string): ModuleCatalogEntry | undefined {
    return this.entriesById.get(moduleId);
  }

  /** Manifest metadata needed to validate a saved Project composition. */
  public composition(moduleId: string): ModuleCompositionMetadata | undefined {
    return this.compositionById.get(moduleId);
  }

  /**
   * Reads request targets only through the producer's declared composition path.
   * Undefined means the contract is untargeted; an empty array means it is targeted
   * but the saved configuration declares no emissions of this contract.
   */
  public configuredRequestTargets(
    moduleId: string,
    configuration: Readonly<Record<string, unknown>> | undefined,
    producedContract: Pick<ModuleContractDescriptor, "type" | "version" | "kind">,
  ): readonly ModuleRequestTarget[] | undefined {
    const produced = this.compositionById
      .get(moduleId)
      ?.produces.find(
        (contract) =>
          contract.type === producedContract.type &&
          contract.version === producedContract.version &&
          contract.kind === producedContract.kind,
      );
    const path = produced?.targeting?.configurationPath;
    if (path === undefined) return undefined;
    if (configuration === undefined) return [];
    return valuesAtConfigurationPath(configuration, path).flatMap(
      toRequestTargetFor(producedContract.type),
    );
  }

  public validateConfiguration(
    moduleId: string,
    configuration: Readonly<Record<string, unknown>>,
  ): ModuleConfigurationValidation {
    if (!this.entriesById.has(moduleId)) {
      return {
        valid: false,
        issues: ["/moduleId is not an accepted bundled Module Package"],
        fields: ["/moduleId"],
      };
    }
    const validate = this.configurationValidators.get(moduleId);
    if (validate === undefined || validate(configuration)) {
      return { valid: true, issues: [], fields: [] };
    }
    const errors = validate.errors ?? [];
    return {
      valid: false,
      issues: errors.map(
        (error) =>
          `${error.instancePath === "" ? "/" : error.instancePath} ${error.message ?? "is invalid"}`,
      ),
      fields: errors.map((error) => {
        const base = error.instancePath === "" ? "" : error.instancePath;
        if (error.keyword === "required") {
          const missing = (error.params as { missingProperty?: unknown }).missingProperty;
          if (typeof missing === "string") return `${base}/${missing}`;
        }
        return base === "" ? "/" : base;
      }),
    };
  }

  public diagnostics(): readonly ModuleCatalogDiagnostic[] {
    return this.rejected;
  }
}

function contractSchemaRefIssues(manifest: ModuleManifest): string[] {
  const groups = [
    ["consumes", manifest.contracts.consumes] as const,
    ["produces", manifest.contracts.produces] as const,
  ];
  return groups.flatMap(([group, contracts]) =>
    contracts.flatMap((contract, index) => {
      const expected = `contracts/events/${contract.type}.v${contract.version}.schema.json`;
      return contract.schemaRef === expected
        ? []
        : [`/contracts/${group}/${index}/schemaRef must identify ${expected}`];
    }),
  );
}

function valuesAtConfigurationPath(
  configuration: Readonly<Record<string, unknown>>,
  path: string,
): readonly unknown[] {
  const segments = path
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  let values: readonly unknown[] = [configuration];
  for (const segment of segments) {
    values = values.flatMap((value) => {
      if (segment === "*") return Array.isArray(value) ? value : [];
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
      const child = (value as Readonly<Record<string, unknown>>)[segment];
      return child === undefined ? [] : [child];
    });
  }
  return values;
}

function toRequestTargetFor(eventType: string) {
  return (value: unknown): ModuleRequestTarget[] => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const emission = value as Readonly<Record<string, unknown>>;
    if (emission["type"] !== eventType) return [];
    const target = emission["target"];
    if (typeof target !== "object" || target === null || Array.isArray(target)) return [];
    const descriptor = target as Readonly<Record<string, unknown>>;
    const moduleInstanceId = descriptor["moduleInstanceId"];
    if (typeof moduleInstanceId === "string") return [{ moduleInstanceId }];
    const binding = descriptor["binding"];
    return typeof binding === "string" ? [{ binding }] : [];
  };
}

function toDiagnostic(
  candidate: DiscoveredModuleManifest,
  error: unknown,
): ModuleCatalogDiagnostic {
  if (error instanceof InvalidModuleManifestError) {
    return { packageName: candidate.packageName, issues: error.issues };
  }
  if (error instanceof ModuleManifestDiscoveryError) {
    return {
      packageName: candidate.packageName,
      issues: [`${error.path} ${error.reason}`],
    };
  }
  if (error instanceof InvalidModuleConfigurationSchemaError) {
    return {
      packageName: candidate.packageName,
      issues: [`${error.path} ${error.reason}`],
    };
  }
  throw error;
}

function toCatalogEntry(
  manifest: ModuleManifest,
  registry: ModulePackageRegistry,
): ModuleCatalogEntry {
  const eventId = (descriptor: ContractDescriptorBase): string =>
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

function configurationValidator(
  schema: Readonly<Record<string, unknown>> | null,
): ValidateFunction | undefined {
  if (schema === null) return undefined;
  try {
    return new Ajv2020({ strict: false, allErrors: true }).compile(schema);
  } catch {
    throw new InvalidModuleConfigurationSchemaError("Configuration schema could not be compiled.");
  }
}

function requireJsonObject(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidModuleConfigurationSchemaError("Configuration schema must be a JSON object.");
  }
  return value as Readonly<Record<string, unknown>>;
}
