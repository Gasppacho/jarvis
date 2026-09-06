/**
 * Ticket #54: the open subscription set is a derived, read-only projection of
 * the immutable Resolved Project (ticket #53) frozen at activation — never a
 * second durable store. Every enabled Module Instance's declared consumed
 * contracts are exactly the open subscriptions for a Project; a disabled
 * instance contributes none (docs/architecture/PROJECTS.md "Activation";
 * docs/architecture/EVENTS.md "Routing" describes routing as manifest-declared
 * contracts plus project membership, both of which the Resolved Project
 * already carries). Before activation, no Resolved Project exists yet, so no
 * subscription is open. Opening a subscription is not delivering an Event:
 * this module never touches delivery, inbox, outbox or execution.
 */
import type { ProjectModuleInstanceConfiguration } from "./project-types.js";

export interface ProjectOpenSubscriptionContract {
  readonly type: string;
  readonly version: number;
  readonly kind: "request" | "fact";
}

export interface ProjectOpenSubscription {
  readonly instanceId: string;
  readonly moduleId: string;
  readonly contract: ProjectOpenSubscriptionContract;
}

export interface ProjectSubscriptions {
  readonly apiVersion: "jarvis.dev/project-subscriptions/v1";
  readonly kind: "ProjectSubscriptions";
  readonly projectId: string;
  readonly items: readonly ProjectOpenSubscription[];
}

/** Manifest metadata the derivation needs beyond the frozen Resolved Project. */
export interface ProjectSubscriptionsPackagePort {
  composition(
    moduleId: string,
  ): { readonly consumes: readonly ProjectOpenSubscriptionContract[] } | undefined;
}

/**
 * `moduleInstances` is the Resolved Project's own frozen list (or `[]` before
 * activation ever succeeded) — never the Project's live, possibly-edited
 * configuration, so the result cannot drift from what was actually activated.
 */
export function deriveProjectSubscriptions(
  projectId: string,
  moduleInstances: readonly ProjectModuleInstanceConfiguration[],
  packages: ProjectSubscriptionsPackagePort,
): ProjectSubscriptions {
  const items = moduleInstances
    .filter((instance) => instance.enabled)
    .flatMap((instance) =>
      (packages.composition(instance.moduleId)?.consumes ?? []).map((contract) => ({
        instanceId: instance.instanceId,
        moduleId: instance.moduleId,
        contract: { type: contract.type, version: contract.version, kind: contract.kind },
      })),
    )
    .sort(
      (left, right) =>
        left.instanceId.localeCompare(right.instanceId) ||
        left.contract.type.localeCompare(right.contract.type) ||
        left.contract.version - right.contract.version,
    );
  return {
    apiVersion: "jarvis.dev/project-subscriptions/v1",
    kind: "ProjectSubscriptions",
    projectId,
    items,
  };
}
