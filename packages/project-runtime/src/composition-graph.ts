/**
 * The composition graph read model: one derived, deterministic, read-only
 * projection of the saved or proposed composition. The engine owns the rules;
 * clients render this model and never reconstruct routing from it.
 */
import type {
  ProjectRequestAttempt,
  ProjectResourceKind,
  ProjectSlotBinding,
  ProjectValidationFinding,
  ProjectValidationInstanceTarget,
  ProjectValidationReport,
  StoredPortableProjectConfiguration,
} from "./project-types.js";

/** Routing decision of one request edge, projected from the validation report. */
export type ProjectCompositionGraphRequestRouting =
  | { readonly status: "resolved"; readonly consumer: ProjectValidationInstanceTarget }
  | { readonly status: "orphaned" }
  | {
      readonly status: "ambiguous";
      readonly candidates: readonly ProjectValidationInstanceTarget[];
    };

export interface ProjectCompositionGraphNode {
  readonly instanceId: string;
  readonly moduleId: string;
  readonly enabled: boolean;
  /** Version of the bundled Module Package; null when the package is unavailable. */
  readonly moduleVersion: string | null;
  /** Display name of the bundled Module Package; null when the package is unavailable. */
  readonly displayName: string | null;
  /** Applicable finding codes (`project.instance-config-invalid`, ...). */
  readonly findings: readonly string[];
}

export interface ProjectCompositionGraphEdge {
  readonly kind: "request" | "fact";
  readonly contract: {
    readonly type: string;
    readonly version: number;
    readonly kind: "request" | "fact";
  };
  readonly from: ProjectValidationInstanceTarget;
  readonly to?: ProjectValidationInstanceTarget;
  /** Present for every request edge; facts are broadcast, not routed. */
  readonly routing?: ProjectCompositionGraphRequestRouting;
  /** Applicable finding codes (`project.request-orphaned`, ...). */
  readonly findings: readonly string[];
}

/** Secondary rail: required capabilities with slot and Local Binding state. */
export type ProjectCompositionGraphCapabilityState = "bound" | "unbound" | "unresolved";

export interface ProjectCompositionGraphSlotRailItem {
  readonly kind: "slot";
  readonly slot: string;
  readonly capability: string;
  readonly state: ProjectCompositionGraphCapabilityState;
  readonly binding?: { readonly kind: ProjectResourceKind; readonly ref: string };
  readonly source?: { readonly kind: ProjectResourceKind | "repository"; readonly ref: string };
  /** Applicable finding codes (`project.binding-missing`, `project.capability-unresolved`). */
  readonly findings: readonly string[];
}

export interface ProjectCompositionGraphInstanceRailItem {
  readonly kind: "module-instance";
  readonly instanceId: string;
  readonly capability: string;
  readonly binding?: string;
  readonly state: ProjectCompositionGraphCapabilityState;
  readonly source?: { readonly kind: ProjectResourceKind | "repository"; readonly ref: string };
  /** Applicable finding codes (`project.capability-unresolved`). */
  readonly findings: readonly string[];
}

export type ProjectCompositionGraphRailItem =
  ProjectCompositionGraphSlotRailItem | ProjectCompositionGraphInstanceRailItem;

export interface ProjectCompositionGraph {
  readonly apiVersion: "jarvis.dev/project-composition-graph/v1";
  readonly kind: "ProjectCompositionGraph";
  readonly projectId: string;
  readonly nodes: readonly ProjectCompositionGraphNode[];
  readonly edges: readonly ProjectCompositionGraphEdge[];
  readonly rail: readonly ProjectCompositionGraphRailItem[];
  /** Every finding of the report, addressed by the stable ids above. */
  readonly findings: readonly (ProjectValidationFinding & { readonly id: string })[];
}

/** Manifest metadata the graph needs beyond the validation report. */
export interface ProjectCompositionGraphPackagePort {
  package(moduleId: string): { readonly version: string; readonly displayName: string } | undefined;
  composition(moduleId: string):
    | {
        readonly requires: readonly {
          readonly id: string;
          readonly binding?: string;
        }[];
      }
    | undefined;
}

export interface ProjectCompositionGraphInput {
  readonly configuration: StoredPortableProjectConfiguration;
  readonly slotBindings: Readonly<Record<string, ProjectSlotBinding>>;
  /** Validation report of exactly this configuration with the current Local Bindings. */
  readonly validation: ProjectValidationReport;
}

export function buildProjectCompositionGraph(
  packages: ProjectCompositionGraphPackagePort,
  input: ProjectCompositionGraphInput,
): ProjectCompositionGraph {
  const { configuration, slotBindings, validation } = input;
  const findings = validation.findings;
  const findingCodes = (match: (finding: ProjectValidationFinding) => boolean): string[] =>
    [...new Set(findings.filter(match).map((finding) => finding.code))].sort();

  const instanceNodeMatch = (instanceId: string) => (finding: ProjectValidationFinding) => {
    const target = finding.target;
    if (target.kind === "module-instance") return target.instanceId === instanceId;
    if (target.kind === "request-edge") return target.producer.instanceId === instanceId;
    if (target.kind === "contract-edge") {
      return target.producer.instanceId === instanceId || target.consumer.instanceId === instanceId;
    }
    return false;
  };

  const nodes = configuration.modules
    .map((instance) => {
      const packageEntry = packages.package(instance.moduleId);
      return {
        instanceId: instance.instanceId,
        moduleId: instance.moduleId,
        enabled: instance.enabled,
        moduleVersion: packageEntry?.version ?? null,
        displayName: packageEntry?.displayName ?? null,
        findings: findingCodes(instanceNodeMatch(instance.instanceId)),
      };
    })
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId));

  const requestEdgeMatch =
    (attempt: ProjectRequestAttempt) => (finding: ProjectValidationFinding) => {
      const target = finding.target;
      if (target.kind === "request-edge") {
        return (
          target.producer.instanceId === attempt.producer.instanceId &&
          target.contract.type === attempt.contract.type &&
          target.contract.version === attempt.contract.version
        );
      }
      if (target.kind === "contract-edge") {
        return (
          target.producer.instanceId === attempt.producer.instanceId &&
          target.producer.contract.type === attempt.contract.type &&
          target.producer.contract.version === attempt.contract.version
        );
      }
      return false;
    };

  const requestEdges = (validation.requestAttempts ?? []).map((attempt) => {
    const findings = findingCodes(requestEdgeMatch(attempt));
    if (attempt.status === "resolved") {
      return {
        kind: "request" as const,
        contract: attempt.contract,
        from: attempt.producer,
        to: attempt.consumer,
        routing: { status: "resolved" as const, consumer: attempt.consumer },
        findings,
      };
    }
    return {
      kind: "request" as const,
      contract: attempt.contract,
      from: attempt.producer,
      routing:
        attempt.status === "ambiguous"
          ? { status: "ambiguous" as const, candidates: attempt.candidates }
          : { status: "orphaned" as const },
      findings,
    };
  });

  const factEdges = (validation.factDeliveries ?? []).map((delivery) => ({
    kind: "fact" as const,
    contract: delivery.contract,
    from: delivery.producer,
    to: delivery.consumer,
    findings: [],
  }));

  const edges = [...requestEdges, ...factEdges].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.contract.type.localeCompare(right.contract.type) ||
      left.contract.version - right.contract.version ||
      left.from.instanceId.localeCompare(right.from.instanceId) ||
      (left.to?.instanceId ?? "").localeCompare(right.to?.instanceId ?? ""),
  );

  const rail = buildRail(packages, configuration, slotBindings, validation, findings);

  return {
    apiVersion: "jarvis.dev/project-composition-graph/v1",
    kind: "ProjectCompositionGraph",
    projectId: validation.projectId,
    nodes,
    edges,
    rail,
    findings: findings.map((finding, index) => ({ ...finding, id: `f${index + 1}` })),
  };
}

function buildRail(
  packages: ProjectCompositionGraphPackagePort,
  configuration: StoredPortableProjectConfiguration,
  slotBindings: Readonly<Record<string, ProjectSlotBinding>>,
  validation: ProjectValidationReport,
  findings: readonly ProjectValidationFinding[],
): ProjectCompositionGraphRailItem[] {
  const satisfied = (kind: "slot" | "module-instance", id: string, capability: string) =>
    validation.satisfiedCapabilities.find(
      (entry) =>
        (kind === "slot"
          ? entry.target.kind === "slot" && entry.target.slot === id
          : entry.target.kind === "module-instance" && entry.target.instanceId === id) &&
        entry.capability === capability,
    );

  const slotFindingCodes = (slot: string, capability: string): string[] =>
    [
      ...new Set(
        findings
          .filter((finding) => {
            const target = finding.target;
            if (target.kind === "capability") {
              return "slot" in target && target.slot === slot && target.capability === capability;
            }
            return target.kind === "slot" && target.slot === slot;
          })
          .map((finding) => finding.code),
      ),
    ].sort();

  const instanceFindingCodes = (instanceId: string, capability: string): string[] =>
    [
      ...new Set(
        findings
          .filter((finding) => {
            const target = finding.target;
            return (
              target.kind === "capability" &&
              "instanceId" in target &&
              target.instanceId === instanceId &&
              target.capability === capability
            );
          })
          .map((finding) => finding.code),
      ),
    ].sort();

  const items: ProjectCompositionGraphRailItem[] = [];
  for (const [slot, requirement] of Object.entries(configuration.slots)) {
    const binding = slotBindings[slot];
    const entry = satisfied("slot", slot, requirement.requires);
    const state: ProjectCompositionGraphCapabilityState =
      entry !== undefined
        ? "bound"
        : slotFindingCodes(slot, requirement.requires).length > 0
          ? "unresolved"
          : "unbound";
    items.push({
      kind: "slot",
      slot,
      capability: requirement.requires,
      state,
      ...(binding === undefined ? {} : { binding }),
      ...(entry === undefined ? {} : { source: entry.source }),
      findings: slotFindingCodes(slot, requirement.requires),
    });
  }
  for (const instance of configuration.modules) {
    if (!instance.enabled) continue;
    for (const requirement of packages.composition(instance.moduleId)?.requires ?? []) {
      const entry = satisfied("module-instance", instance.instanceId, requirement.id);
      const state: ProjectCompositionGraphCapabilityState =
        entry !== undefined
          ? "bound"
          : instanceFindingCodes(instance.instanceId, requirement.id).length > 0
            ? "unresolved"
            : "unbound";
      items.push({
        kind: "module-instance",
        instanceId: instance.instanceId,
        capability: requirement.id,
        state,
        ...(entry === undefined ? {} : { source: entry.source }),
        ...(requirement.binding === undefined ? {} : { binding: requirement.binding }),
        findings: instanceFindingCodes(instance.instanceId, requirement.id),
      });
    }
  }
  return items.sort((left, right) =>
    (
      left.kind +
      "\u0000" +
      (left.kind === "slot" ? left.slot : left.instanceId) +
      "\u0000" +
      left.capability
    ).localeCompare(
      right.kind +
        "\u0000" +
        (right.kind === "slot" ? right.slot : right.instanceId) +
        "\u0000" +
        right.capability,
    ),
  );
}
