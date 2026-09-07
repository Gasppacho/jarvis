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
import { failpoint } from "../test-support/failpoint.js";

/**
 * Review fix for ticket #58: substituted by tsup's `define` (tsup.config.ts)
 * with a literal `false` for the entry `scripts/build-app.sh` packages, which
 * lets esbuild drop the `failpoint()` call below — and, with nothing else
 * referencing it, the whole `test-support/failpoint.ts` module — from the
 * production bundle. `typeof` guards the reference so unbundled execution
 * (typecheck, unit tests importing this module directly) never throws on an
 * identifier that only tsup ever defines; undefined there is treated as "on",
 * matching this file's behavior before this flag existed.
 */
declare const __JARVIS_TEST_HOOKS__: boolean | undefined;

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

/** Exported so the composition root (main.ts) can share this literal instead
 * of duplicating it when computing an overridable lease duration. */
export const DEFAULT_LEASE_MS = 30_000;

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
    const claimed = this.claim(limit);
    // Ticket #58 acceptance criterion 5: a declared boundary between the
    // lease-claim transaction's commit (above) and journaling/Delivery
    // creation (below). A process killed here leaves the row `pending` under
    // a live lease — reclaimable once that lease expires, never stranded.
    if (typeof __JARVIS_TEST_HOOKS__ === "undefined" || __JARVIS_TEST_HOOKS__) {
      failpoint("after-outbox-claim");
    }
    // Review fix (major) for ticket #58: one row per `try`, not `.map()` over
    // the whole claimed batch. A single malformed envelope (`requireEnvelope`
    // throwing) must not also strand every row claimed after it in this same
    // batch — `.map()` aborts on the first throw, and since a reclaim after
    // lease expiry re-batches the same bad row ahead of the same later rows
    // every time, that would starve them forever, not just this one tick.
    // Left `pending` under its lease, reclaimed and retried next tick;
    // actually resolving it is #17 (retries/backoff/dead letters).
    const dispatched: DispatchedEvent[] = [];
    for (const row of claimed) {
      try {
        dispatched.push(this.dispatchOne(row));
      } catch (error) {
        // The stable code (event.envelope-invalid, ...) is worth keeping in
        // the log even once stringified — it is the only thing distinguishing
        // "malformed envelope" from an arbitrary routing failure once this is
        // just a line of stderr.
        const detail =
          error instanceof EngineError ? `${error.code}: ${error.message}` : String(error);
        process.stderr.write(
          `jarvis-engine: dispatching outbox row ${row.eventId} failed: ${detail}\n`,
        );
      }
    }
    return dispatched;
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
          `INSERT INTO events
             (id, project_id, type, version, kind, envelope, occurred_at, recorded_at, correlation_id)
           VALUES
             (@id, @projectId, @type, @version, @kind, @envelope, @occurredAt, @recordedAt, @correlationId)
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
          // Ticket #59 (0008_events_correlation_id.sql): written alongside the
          // envelope itself rather than left to the migration's backfill, so
          // the indexed `correlationId` filter in GET
          // /v1/projects/{projectId}/events is correct for every row a
          // running engine ever journals, not only rows that predate it.
          correlationId: envelope.correlationId,
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
