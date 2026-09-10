import type { EventEnvelope } from "./envelope.js";

/**
 * Ticket #56 docs/architecture/EVENTS.md "Routing > Facts": a fact is
 * delivered to zero, one or many active consumers whose open subscription
 * declares the same (type, version, kind). Zero consumers is legal — the
 * fact stays journaled and auditable.
 *
 * Deliberately a structural mirror of
 * `packages/project-runtime/src/project-subscriptions.ts`'s
 * `ProjectOpenSubscription`, not an import of it: eventing resolves against
 * whatever open-subscription shape it is handed, without taking a dependency
 * on Project Runtime's domain types.
 */
export interface EventingOpenSubscription {
  readonly instanceId: string;
  readonly moduleId: string;
  readonly contract: {
    readonly type: string;
    readonly version: number;
    readonly kind: "request" | "fact";
  };
}

export interface RoutedConsumer {
  readonly moduleInstanceId: string;
  readonly moduleId: string;
}

/** Structural view of a frozen Project request route. */
export interface EventingRequestRoute {
  readonly contract: {
    readonly type: string;
    readonly version: number;
    readonly kind: "request";
  };
  readonly producer: {
    readonly instanceId: string;
    readonly moduleId: string;
  };
  readonly consumer: {
    readonly instanceId: string;
    readonly moduleId: string;
  };
}

/** Only the producer fields needed to resolve a target binding. */
export interface EventingRequestModuleInstance {
  readonly instanceId: string;
  readonly moduleId: string;
  readonly bindings?: Readonly<Record<string, string>>;
}

export interface EventingRequestSlotBinding {
  readonly kind: string;
  readonly ref: string;
}

/** Structural view of `ResolvedProjectSnapshot`, keeping eventing decoupled. */
export interface EventingRequestRoutingSnapshot {
  readonly moduleInstances: readonly EventingRequestModuleInstance[];
  readonly bindings: {
    readonly slots: Readonly<Record<string, EventingRequestSlotBinding>>;
  };
  readonly requestRoutes: readonly EventingRequestRoute[];
}

export type RequestRoutingErrorCode =
  | "request-target-missing"
  | "request-consumer-not-found"
  | "request-consumer-ambiguous"
  | "request-routing-unconfigured";

export class RequestRoutingError extends Error {
  public constructor(
    public readonly code: RequestRoutingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RequestRoutingError";
  }
}

export type RequestEnvelope = Pick<
  EventEnvelope,
  "projectId" | "type" | "version" | "kind" | "producer" | "target"
> & { readonly kind: "request" };

/**
 * Resolve one request against the immutable Project snapshot. Facts keep the
 * broadcast resolver above; requests never fall back to subscription fan-out.
 */
export function resolveRequestConsumer(
  envelope: RequestEnvelope,
  snapshot: EventingRequestRoutingSnapshot,
): RoutedConsumer {
  const target = envelope.target;
  if (target === undefined) {
    throw new RequestRoutingError(
      "request-target-missing",
      `Request ${envelope.type}.v${envelope.version} has no target.`,
    );
  }

  const targetConsumers =
    target.moduleInstanceId !== undefined
      ? [target.moduleInstanceId]
      : target.binding === undefined
        ? undefined
        : resolveBindingTargets(envelope, target.binding, snapshot);
  const routes = snapshot.requestRoutes.filter(
    (route) =>
      route.contract.type === envelope.type &&
      route.contract.version === envelope.version &&
      route.producer.moduleId === envelope.producer.moduleId &&
      route.producer.instanceId === envelope.producer.moduleInstanceId &&
      (targetConsumers === undefined || targetConsumers.includes(route.consumer.instanceId)),
  );

  // Counted by distinct consumer, not by route: a producer that configures
  // several emissions of one contract at the same consumer (an Automation Rules
  // Rule Set matching different tags into one Development instance is the
  // normal case) contributes one route per configured target, and those routes
  // are identical. Ambiguity means genuinely *different* candidates — counting
  // rows instead would reject every such Rule Set as ambiguous. Deduplicating
  // here rather than only where the report is built also covers snapshots
  // frozen into `resolved_project` before that dedupe existed.
  const consumers = new Map<string, RoutedConsumer>();
  for (const route of routes) {
    const consumer = route.consumer;
    consumers.set(`${consumer.moduleId}\u0000${consumer.instanceId}`, {
      moduleInstanceId: consumer.instanceId,
      moduleId: consumer.moduleId,
    });
  }

  if (consumers.size === 0) {
    throw new RequestRoutingError(
      "request-consumer-not-found",
      `Request ${envelope.type}.v${envelope.version} from ${envelope.producer.moduleInstanceId} has no target consumer.`,
    );
  }
  if (consumers.size > 1) {
    throw new RequestRoutingError(
      "request-consumer-ambiguous",
      `Request ${envelope.type}.v${envelope.version} from ${envelope.producer.moduleInstanceId} has multiple target consumers.`,
    );
  }

  return [...consumers.values()][0]!;
}

function resolveBindingTargets(
  envelope: RequestEnvelope,
  binding: string,
  snapshot: EventingRequestRoutingSnapshot,
): readonly string[] {
  const producer = snapshot.moduleInstances.find(
    (instance) =>
      instance.instanceId === envelope.producer.moduleInstanceId &&
      instance.moduleId === envelope.producer.moduleId,
  );
  const slot = producer?.bindings?.[binding] ?? binding;
  const slotBinding = snapshot.bindings.slots[slot];
  if (slotBinding?.kind === "module-instance") return [slotBinding.ref];
  if (slotBinding === undefined) return [];

  const targetConsumers = new Set<string>();
  for (const route of snapshot.requestRoutes) {
    if (
      route.contract.type !== envelope.type ||
      route.contract.version !== envelope.version ||
      route.producer.moduleId !== envelope.producer.moduleId ||
      route.producer.instanceId !== envelope.producer.moduleInstanceId
    ) {
      continue;
    }
    const consumer = snapshot.moduleInstances.find(
      (instance) => instance.instanceId === route.consumer.instanceId,
    );
    if (Object.values(consumer?.bindings ?? {}).includes(slot)) {
      targetConsumers.add(route.consumer.instanceId);
    }
  }
  return [...targetConsumers];
}

/**
 * Pure routing resolution: the caller has already scoped `subscriptions` to
 * the event's own Project (docs/architecture/EVENTS.md "Un fact appartienne
 * au même projet"), so this never reaches across a Project boundary — it has
 * no Project identity to reach with.
 */
export function resolveConsumers(
  envelope: { readonly type: string; readonly version: number; readonly kind: "request" | "fact" },
  subscriptions: readonly EventingOpenSubscription[],
): readonly RoutedConsumer[] {
  return subscriptions
    .filter(
      (subscription) =>
        subscription.contract.type === envelope.type &&
        subscription.contract.version === envelope.version &&
        subscription.contract.kind === envelope.kind,
    )
    .map((subscription) => ({
      moduleInstanceId: subscription.instanceId,
      moduleId: subscription.moduleId,
    }));
}
