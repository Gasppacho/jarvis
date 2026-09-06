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
