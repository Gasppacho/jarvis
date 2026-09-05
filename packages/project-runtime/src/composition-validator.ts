import { createHash } from "node:crypto";
import type {
  ProjectFactDelivery,
  ProjectRequestAttempt,
  ProjectResourceCandidate,
  StoredPortableProjectConfiguration,
  ProjectValidationFinding,
  ProjectValidationReport,
} from "./project-types.js";

export interface ProjectModuleContractDescriptor {
  readonly type: string;
  readonly version: number;
  readonly kind: "request" | "fact";
  readonly schemaRef: string;
}

export interface ProjectModuleCapabilityRequirement {
  readonly id: string;
  readonly optional?: boolean;
  readonly binding?: string;
  readonly resolution?:
    | { readonly kind: "engine"; readonly ref: string }
    | { readonly kind: "project-repository" }
    | undefined;
}

export interface ProjectModuleComposition {
  readonly consumes: readonly ProjectModuleContractDescriptor[];
  readonly produces: readonly ProjectModuleContractDescriptor[];
  readonly requires: readonly ProjectModuleCapabilityRequirement[];
  readonly provides: readonly string[];
}

export interface ProjectModulePackageValidationPort {
  package(moduleId: string): { readonly provides: readonly string[] } | undefined;
  composition(moduleId: string): ProjectModuleComposition | undefined;
  configuredRequestTargets(
    moduleId: string,
    configuration: Readonly<Record<string, unknown>> | undefined,
    producedContract: Pick<ProjectModuleContractDescriptor, "type" | "version" | "kind">,
  ): readonly { readonly moduleInstanceId?: string; readonly binding?: string }[] | undefined;
  validateConfiguration(
    moduleId: string,
    configuration: Readonly<Record<string, unknown>>,
  ): { readonly issues: readonly string[]; readonly fields: readonly string[] };
}

export interface SavedProjectCompositionValidationInput {
  readonly projectId: string;
  readonly configuration: StoredPortableProjectConfiguration;
  readonly slotBindings: Readonly<
    Record<string, { readonly kind: ProjectResourceCandidate["kind"]; readonly ref: string }>
  >;
  readonly repositoryBinding: {
    readonly saved: boolean;
    readonly accessible: boolean;
    /** Local Binding: the canonical repository path, for the composition fingerprint. */
    readonly path: string;
    /** Local Binding: the shell-owned bookmark reference, for the composition fingerprint. */
    readonly bookmarkRef: string | null;
  };
  readonly grantedResources: readonly ProjectResourceCandidate[];
}

export interface ProjectCompositionValidationPort {
  validate(input: SavedProjectCompositionValidationInput): ProjectValidationReport;
}

export class SavedProjectCompositionValidator implements ProjectCompositionValidationPort {
  public constructor(private readonly modules: ProjectModulePackageValidationPort) {}

  public validate(project: SavedProjectCompositionValidationInput): ProjectValidationReport {
    const modules = this.modules;
    const configuration = project.configuration;
    const allInstances = configuration.modules;
    const instances = allInstances.filter((instance) => instance.enabled);
    const candidates = projectResourceCandidates(configuration, modules, project.grantedResources);
    const findings: ProjectValidationFinding[] = [];
    const requestRoutes: ProjectValidationReport["requestRoutes"][number][] = [];
    const requestAttempts: ProjectRequestAttempt[] = [];
    const factDeliveries: ProjectFactDelivery[] = [];
    const satisfiedCapabilities: ProjectValidationReport["satisfiedCapabilities"][number][] = [];

    if (allInstances.length === 0 || Object.keys(configuration.slots).length === 0) {
      findings.push({
        code: "project.composition-incomplete",
        severity: "error",
        message: "The Project Draft needs at least one Module Instance and one Project Slot.",
        target: { kind: "project", field: "/modules" },
      });
    }

    for (const instance of allInstances) {
      if (modules.package(instance.moduleId) === undefined) {
        findings.push({
          code: "project.module-package-unavailable",
          severity: "error",
          message: `Module Package ${instance.moduleId} for Module Instance ${instance.instanceId} is unavailable.`,
          target: { kind: "module-instance", instanceId: instance.instanceId, field: "/moduleId" },
        });
        continue;
      }
      const validation = modules.validateConfiguration(
        instance.moduleId,
        instance.configuration ?? {},
      );
      for (const [issueIndex, issue] of validation.issues.entries()) {
        findings.push({
          code: "project.instance-config-invalid",
          severity: "error",
          message: `Module Instance ${instance.instanceId} has invalid configuration at ${issue}.`,
          target: {
            kind: "module-instance",
            instanceId: instance.instanceId,
            field: `/configuration${validation.fields[issueIndex] ?? "/"}`,
          },
        });
      }
    }

    const consumers = instances.flatMap((instance) =>
      (modules.composition(instance.moduleId)?.consumes ?? []).map((contract) => ({
        instance,
        contract,
      })),
    );
    for (const producer of instances) {
      for (const produced of modules.composition(producer.moduleId)?.produces ?? []) {
        if (produced.kind === "fact") {
          const relatedConsumers = consumers.filter(
            ({ contract }) => contract.type === produced.type,
          );
          for (const candidate of relatedConsumers) {
            if (
              candidate.contract.type === produced.type &&
              candidate.contract.version === produced.version &&
              candidate.contract.kind === produced.kind
            ) {
              factDeliveries.push({
                contract: { type: produced.type, version: produced.version, kind: "fact" },
                producer: instanceTarget(producer),
                consumer: instanceTarget(candidate.instance),
              });
              continue;
            }
            findings.push(contractIncompatibleFinding(producer, produced, candidate));
          }
          continue;
        }
        const edge = {
          contract: requestContractTarget(produced),
          producer: instanceTarget(producer),
        };
        const configuredTargets = modules.configuredRequestTargets(
          producer.moduleId,
          producer.configuration,
          produced,
        );
        for (const configuredTarget of configuredTargets ?? [undefined]) {
          const scopedConsumers = consumers.filter(({ instance }) => {
            if (configuredTarget === undefined) return true;
            if (configuredTarget.moduleInstanceId !== undefined) {
              return instance.instanceId === configuredTarget.moduleInstanceId;
            }
            const slot =
              producer.bindings?.[configuredTarget.binding ?? ""] ?? configuredTarget.binding ?? "";
            const binding = project.slotBindings[slot];
            return binding?.kind === "module-instance" && instance.instanceId === binding.ref;
          });
          const matching = scopedConsumers.filter(
            ({ contract }) =>
              contract.type === produced.type &&
              contract.version === produced.version &&
              contract.kind === produced.kind,
          );
          if (matching.length === 1) {
            const consumer = instanceTarget(matching[0]!.instance);
            requestRoutes.push({ ...edge, consumer });
            requestAttempts.push({ ...edge, status: "resolved", consumer });
            continue;
          }
          if (matching.length > 1) {
            const candidates = matching
              .map(({ instance }) => instanceTarget(instance))
              .sort(compareJson);
            requestAttempts.push({
              contract: edge.contract,
              producer: edge.producer,
              status: "ambiguous",
              candidates,
            });
            findings.push({
              code: "project.request-ambiguous",
              severity: "error",
              message: `Request ${produced.type}.v${produced.version} from ${producer.instanceId} has multiple consumers.`,
              target: {
                kind: "request-edge",
                ...edge,
                candidates,
              },
            });
            continue;
          }
          requestAttempts.push({
            contract: edge.contract,
            producer: edge.producer,
            status: "orphaned",
          });
          const relatedConsumers = scopedConsumers.filter(
            ({ contract }) => contract.type === produced.type,
          );
          const incompatible =
            relatedConsumers.length > 0
              ? relatedConsumers
              : configuredTarget !== undefined
                ? scopedConsumers
                : [];
          if (incompatible.length === 0) {
            findings.push({
              code: "project.request-orphaned",
              severity: "error",
              message: `Request ${produced.type}.v${produced.version} from ${producer.instanceId} has no consumer.`,
              target: { kind: "request-edge", ...edge },
            });
          } else {
            for (const candidate of incompatible) {
              findings.push(contractIncompatibleFinding(producer, produced, candidate));
            }
          }
        }
      }
    }

    for (const [slot, requirement] of Object.entries(configuration.slots)) {
      const binding = project.slotBindings[slot];
      if (binding === undefined) {
        if (requirement.optional !== true) {
          findings.push({
            code: "project.binding-missing",
            severity: "error",
            message: `Required slot ${slot} has no Local Binding.`,
            target: { kind: "slot", slot },
          });
        }
        continue;
      }
      const candidate = resolveCapabilityCandidate(candidates, binding, requirement.requires);
      if (candidate === undefined) {
        if (requirement.optional !== true) {
          findings.push({
            code: "project.capability-unresolved",
            severity: "error",
            message: `Binding ${slot} does not resolve capability ${requirement.requires}.`,
            target: { kind: "capability", slot, capability: requirement.requires },
          });
        }
        continue;
      }
      satisfiedCapabilities.push({
        capability: requirement.requires,
        target: { kind: "slot", slot },
        source: { kind: candidate.kind, ref: candidate.ref },
      });
    }

    for (const instance of instances) {
      for (const requirement of modules.composition(instance.moduleId)?.requires ?? []) {
        if (requirement.resolution?.kind === "engine") {
          const resolved = resolveCapabilityCandidate(
            candidates,
            { kind: "engine", ref: requirement.resolution.ref },
            requirement.id,
          );
          if (resolved === undefined) {
            addCapabilityFinding(
              findings,
              instance.instanceId,
              requirement.id,
              undefined,
              `Module Instance ${instance.instanceId} cannot resolve capability ${requirement.id} because Engine service ${requirement.resolution.ref} is unavailable.`,
              requirement.optional,
            );
          } else {
            satisfiedCapabilities.push({
              capability: requirement.id,
              target: { kind: "module-instance", instanceId: instance.instanceId },
              source: { kind: resolved.kind, ref: resolved.ref },
            });
          }
          continue;
        }
        if (requirement.binding === undefined) {
          addCapabilityFinding(
            findings,
            instance.instanceId,
            requirement.id,
            undefined,
            undefined,
            requirement.optional,
          );
          continue;
        }
        const reference =
          instance.bindings?.[requirement.binding] ??
          (requirement.binding === "agentRuntime" ? instance.runtimeSlot : undefined);
        if (reference === undefined) {
          addCapabilityFinding(
            findings,
            instance.instanceId,
            requirement.id,
            requirement.binding,
            undefined,
            requirement.optional,
          );
          continue;
        }
        if (requirement.resolution?.kind === "project-repository") {
          const declared = configuration.repositories.some(
            (repository) => repository.id === reference,
          );
          const localBindingSaved = declared && project.repositoryBinding.saved;
          const accessible = localBindingSaved && project.repositoryBinding.accessible;
          if (accessible) {
            satisfiedCapabilities.push({
              capability: requirement.id,
              target: { kind: "module-instance", instanceId: instance.instanceId },
              source: { kind: "repository", ref: `repository/${reference}` },
            });
          } else {
            const reason = !declared
              ? `repository ${reference} is not declared by the Project`
              : !localBindingSaved
                ? `repository ${reference} has no saved Local Binding`
                : `repository ${reference} is not accessible at its saved Local Binding`;
            addCapabilityFinding(
              findings,
              instance.instanceId,
              requirement.id,
              requirement.binding,
              `Module Instance ${instance.instanceId} cannot resolve capability ${requirement.id} because ${reason}.`,
              requirement.optional,
            );
          }
          continue;
        }
        const slotBinding = project.slotBindings[reference];
        const resolved =
          slotBinding === undefined
            ? undefined
            : resolveCapabilityCandidate(candidates, slotBinding, requirement.id);
        if (resolved === undefined) {
          addCapabilityFinding(
            findings,
            instance.instanceId,
            requirement.id,
            requirement.binding,
            undefined,
            requirement.optional,
          );
        } else {
          satisfiedCapabilities.push({
            capability: requirement.id,
            target: { kind: "module-instance", instanceId: instance.instanceId },
            source: { kind: resolved.kind, ref: resolved.ref },
          });
        }
      }
    }

    findings.sort(compareJson);
    requestRoutes.sort(compareJson);
    requestAttempts.sort(compareJson);
    factDeliveries.sort(compareJson);
    satisfiedCapabilities.sort(compareJson);
    return {
      apiVersion: "jarvis.dev/project-validation/v1",
      kind: "ProjectValidationReport",
      projectId: project.projectId,
      valid: findings.every((finding) => finding.severity !== "error"),
      requestRoutes,
      requestAttempts,
      factDeliveries,
      satisfiedCapabilities,
      findings,
      compositionFingerprint: fingerprintComposition(project),
    };
  }
}

/**
 * A stable digest of exactly the saved state a validation report describes:
 * the Portable Configuration and the Local Bindings (slot bindings and the
 * repository binding). Global resource grants are deliberately excluded —
 * ticket #53's activation guard reacts only to configuration or Local
 * Bindings changing, never to the global registries the report also reads.
 */
function fingerprintComposition(project: SavedProjectCompositionValidationInput): string {
  const canonical = canonicalizeJson({
    configuration: project.configuration,
    slotBindings: project.slotBindings,
    repository: {
      path: project.repositoryBinding.path,
      bookmarkRef: project.repositoryBinding.bookmarkRef,
    },
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Recursively sorts object keys so semantically identical input always serializes identically. */
function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalizeJson(child)]),
  );
}

function contractIncompatibleFinding(
  producer: { readonly instanceId: string; readonly moduleId: string },
  produced: {
    readonly type: string;
    readonly version: number;
    readonly kind: "request" | "fact";
  },
  candidate: {
    readonly instance: { readonly instanceId: string; readonly moduleId: string };
    readonly contract: {
      readonly type: string;
      readonly version: number;
      readonly kind: "request" | "fact";
    };
  },
): ProjectValidationFinding {
  return {
    code: "project.contract-incompatible",
    severity: "error",
    message: `The produced and consumed contracts between ${producer.instanceId} and ${candidate.instance.instanceId} are incompatible.`,
    target: {
      kind: "contract-edge",
      producer: { ...instanceTarget(producer), contract: contractTarget(produced) },
      consumer: {
        ...instanceTarget(candidate.instance),
        contract: contractTarget(candidate.contract),
      },
    },
  };
}

function addCapabilityFinding(
  findings: ProjectValidationFinding[],
  instanceId: string,
  capability: string,
  binding?: string,
  message = `Module Instance ${instanceId} cannot resolve capability ${capability}.`,
  optional = false,
): void {
  if (optional) return;
  findings.push({
    code: "project.capability-unresolved",
    severity: "error",
    message,
    target: {
      kind: "capability",
      instanceId,
      capability,
      ...(binding === undefined ? {} : { binding }),
    },
  });
}

function instanceTarget(instance: { readonly instanceId: string; readonly moduleId: string }) {
  return { instanceId: instance.instanceId, moduleId: instance.moduleId };
}

function contractTarget(contract: {
  readonly type: string;
  readonly version: number;
  readonly kind: "request" | "fact";
}) {
  return { type: contract.type, version: contract.version, kind: contract.kind };
}

function requestContractTarget(
  contract: Pick<ReturnType<typeof contractTarget>, "type" | "version">,
) {
  return { type: contract.type, version: contract.version, kind: "request" as const };
}

export function projectResourceCandidates(
  configuration: StoredPortableProjectConfiguration,
  modules: ProjectModulePackageValidationPort,
  grantedResources: readonly ProjectResourceCandidate[],
): readonly ProjectResourceCandidate[] {
  const selected = configuration.modules.flatMap((instance) => {
    const packageEntry = modules.package(instance.moduleId);
    if (!instance.enabled || packageEntry === undefined || packageEntry.provides.length === 0) {
      return [];
    }
    return [
      {
        ref: instance.instanceId,
        kind: "module-instance" as const,
        displayName: instance.instanceId,
        capabilities: packageEntry.provides,
      },
    ];
  });
  return [...selected, ...grantedResources];
}

function resolveCapabilityCandidate(
  candidates: readonly ProjectResourceCandidate[],
  source: Pick<ProjectResourceCandidate, "kind" | "ref">,
  capability: string,
): ProjectResourceCandidate | undefined {
  return candidates.find(
    (candidate) =>
      candidate.kind === source.kind &&
      candidate.ref === source.ref &&
      candidate.capabilities.includes(capability),
  );
}

function compareJson(left: unknown, right: unknown): number {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}
