import type Database from "better-sqlite3";
import type { Clock } from "../../../../packages/kernel/src/clock.js";
import type { IdGenerator } from "../../../../packages/kernel/src/id-generator.js";
import {
  EventEnvelopeContractRegistry,
  InvalidEventEnvelopeError,
  type EventEnvelope,
} from "../../../../packages/eventing/src/envelope.js";
import {
  resolveConsumers,
  type EventingOpenSubscription,
  type RoutedConsumer,
} from "../../../../packages/eventing/src/routing.js";
import { EngineError } from "../errors.js";

/** The event's own Project's open subscriptions — never another Project's
 * (issue #56 "every written row carries projectId and is unreachable across
 * Project boundaries"). Compose from `deriveProjectSubscriptions`
 * (packages/project-runtime/src/project-subscriptions.ts) plus
 * `ProjectStore.getResolvedProject`; the dispatcher never rederives it. */
export type OpenSubscriptionsPort = (projectId: string) => readonly EventingOpenSubscription[];

export interface DispatchedEvent {
  readonly eventId: string;
  readonly projectId: string;
  readonly type: string;
  readonly version: number;
  readonly kind: "request" | "fact";
  readonly deliveries: readonly RoutedConsumer[];
}

interface ClaimedOutboxRow {
  readonly eventId: string;
  readonly envelope: string;
}

const DEFAULT_LEASE_MS = 30_000;

/**
 * Ticket #56 (docs/architecture/PERSISTENCE.md "Outbox dispatcher"): claims
 * pending Outbox rows by lease, journals each exactly once keyed by event id,
 * resolves routing against the event's own Project's open subscriptions, and
 * creates the resulting Deliveries atomically with the dispatch marking.
 * Nothing here invokes a handler or creates an Execution (#57).
 */
export class OutboxDispatcher {
  public constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly envelopes: EventEnvelopeContractRegistry,
    private readonly openSubscriptions: OpenSubscriptionsPort,
    private readonly leaseMs: number = DEFAULT_LEASE_MS,
  ) {}

  public dispatchPending(limit = 50): readonly DispatchedEvent[] {
    return this.claim(limit).map((row) => this.dispatchOne(row));
  }

  /** One short transaction: claiming must not race a concurrent dispatcher
   * onto the same row, and must not hold the lease past its own commit. */
  private claim(limit: number): readonly ClaimedOutboxRow[] {
    return this.db.transaction(() => {
      const now = this.clock.now();
      // A row another dispatcher still holds is not claimable; an expired lease
      // is, so a lease held by a killed process is reclaimed rather than
      // stranding the row (docs/architecture/PERSISTENCE.md "Outbox dispatcher").
      const rows = this.db
        .prepare(
          `SELECT event_id, envelope FROM outbox
           WHERE status = 'pending'
             AND (lease_expires_at IS NULL OR lease_expires_at <= @now)
           ORDER BY created_at
           LIMIT @limit`,
        )
        .all({ now: now.toISOString(), limit }) as { event_id: string; envelope: string }[];

      const leaseOwner = this.ids.next();
      const leaseExpiresAt = new Date(now.getTime() + this.leaseMs).toISOString();
      for (const row of rows) {
        this.db
          .prepare(
            `UPDATE outbox SET lease_owner = ?, lease_expires_at = ?
             WHERE event_id = ? AND status = 'pending'`,
          )
          .run(leaseOwner, leaseExpiresAt, row.event_id);
      }
      return rows.map((row) => ({ eventId: row.event_id, envelope: row.envelope }));
    })();
  }

  /**
   * Journal append, routing resolution, Delivery creation and the dispatch
   * marking all commit in one transaction — issue #56's consistency
   * criterion ("no Delivery exists without its journal entry, and no Outbox
   * row is marked dispatched without its Deliveries") is exactly what a
   * single transaction gives for free. The journal and Delivery inserts are
   * additionally idempotent (`ON CONFLICT ... DO NOTHING`) so a stray second
   * attempt at the same event id — the row reclaimed after a crash, or a
   * direct retry — cannot duplicate either.
   */
  private dispatchOne(row: ClaimedOutboxRow): DispatchedEvent {
    return this.db.transaction(() => {
      const envelope = this.requireEnvelope(row.envelope);
      const recordedAt = this.clock.now().toISOString();

      this.db
        .prepare(
          `INSERT INTO events (id, project_id, type, version, kind, envelope, occurred_at, recorded_at)
           VALUES (@id, @projectId, @type, @version, @kind, @envelope, @occurredAt, @recordedAt)
           ON CONFLICT (id) DO NOTHING`,
        )
        .run({
          id: envelope.id,
          projectId: envelope.projectId,
          type: envelope.type,
          version: envelope.version,
          kind: envelope.kind,
          envelope: JSON.stringify(envelope),
          occurredAt: envelope.occurredAt,
          recordedAt,
        });

      // ponytail: Requests must resolve to exactly one consumer via
      // target/binding resolution (EVENTS.md "Routing > Requests"), which
      // needs Project Runtime's binding resolution, not subscription
      // fan-out. Out of #56's scope — no acceptance criterion exercises a
      // request here, so it journals with zero Deliveries until that lands.
      const consumers =
        envelope.kind === "fact"
          ? resolveConsumers(envelope, this.openSubscriptions(envelope.projectId))
          : [];

      for (const consumer of consumers) {
        this.db
          .prepare(
            `INSERT INTO deliveries (id, project_id, event_id, module_instance_id, module_id, created_at)
             VALUES (@id, @projectId, @eventId, @moduleInstanceId, @moduleId, @createdAt)
             ON CONFLICT (event_id, module_instance_id) DO NOTHING`,
          )
          .run({
            id: `dlv_${this.ids.next()}`,
            projectId: envelope.projectId,
            eventId: envelope.id,
            moduleInstanceId: consumer.moduleInstanceId,
            moduleId: consumer.moduleId,
            createdAt: recordedAt,
          });
      }

      this.db
        .prepare(`UPDATE outbox SET status = 'dispatched', dispatched_at = ? WHERE event_id = ?`)
        .run(recordedAt, envelope.id);

      return {
        eventId: envelope.id,
        projectId: envelope.projectId,
        type: envelope.type,
        version: envelope.version,
        kind: envelope.kind,
        deliveries: consumers,
      };
    })();
  }

  private requireEnvelope(json: string): EventEnvelope {
    try {
      return this.envelopes.requireEnvelope(JSON.parse(json) as unknown);
    } catch (error) {
      if (error instanceof InvalidEventEnvelopeError) {
        throw new EngineError("event.envelope-invalid", 500, error.message, {
          issues: [...error.issues],
        });
      }
      throw error;
    }
  }
}
