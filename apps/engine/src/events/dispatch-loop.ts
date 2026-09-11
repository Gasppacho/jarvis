import type Database from "better-sqlite3";
import type { Clock } from "../../../../packages/kernel/src/clock.js";
import {
  SystemIdGenerator,
  type IdGenerator,
} from "../../../../packages/kernel/src/id-generator.js";
import type { ClaimedDelivery, DeliveryConsumer } from "../executions/delivery-consumer.js";
import type { LiveUpdatePort } from "../stream/hub.js";
import { summarizeEventEnvelope } from "./timeline.js";
import type { OutboxDispatcher } from "./dispatcher.js";

export interface EventLoopDependencies {
  readonly db: Database.Database;
  readonly clock: Clock;
  readonly dispatcher: OutboxDispatcher;
  readonly consumer: DeliveryConsumer;
  readonly ids?: Pick<IdGenerator, "next">;
  readonly deliveryLeaseMs?: number;
  /** Ticket #60: fed one Live Update per journaled Event and per recorded
   * Execution, always after that row's own transaction has already
   * committed (see the two call sites below) — never before, so a rolled
   * back attempt can never produce one. */
  readonly liveUpdates: LiveUpdatePort;
}

export const DEFAULT_DELIVERY_LEASE_MS = 30_000;

/**
 * Ticket #58: the always-on production wiring the parent issue (#6, "the
 * whole durable path must be demonstrable end to end") needs. Every tick does
 * two things, in order, so a crash between them can never strand work:
 *
 *   1. `dispatcher.dispatchPending()` claims, journals and fans out any
 *      pending Outbox row into Deliveries (docs/architecture/PERSISTENCE.md
 *      "Outbox dispatcher");
 *   2. every Delivery not yet marked `consumed_at` — including ones a
 *      process that crashed mid-handler left behind, from this tick or a
 *      prior one — is handed to `consumer.consume()`.
 *
 * Step 2 reading `deliveries` directly rather than trusting step 1's return
 * value is what recovers a Delivery a killed process claimed but never
 * consumed (ticket #58 acceptance criteria 2-4): nothing here assumes the
 * process that dispatched a row is the one that consumes it.
 *
 * The loop polls at a fixed interval, while retry eligibility is persisted on
 * each Delivery. A Delivery whose next attempt is not due is not loaded or
 * offered to its handler.
 */
export async function tickEventLoop(deps: EventLoopDependencies): Promise<void> {
  // Review fix for ticket #58: guarded the same way the per-delivery
  // `consume()` call below already is. A single malformed Outbox row (a bad
  // envelope `requireEnvelope` cannot parse) must not take the whole engine
  // down — no other tick depends on this one, and an uncaught throw here
  // used to crash the process while the row stayed `pending`, so a restart
  // reclaimed and rethrew on it forever. Logged and retried next tick
  // instead; actually resolving such a row is #17 (retries/backoff/dead
  // letters), out of scope here.
  try {
    const dispatched = deps.dispatcher.dispatchPending();
    if (dispatched.length > 0) {
      process.stderr.write(
        `jarvis-engine: dispatched ${dispatched.length} pending outbox row(s)\n`,
      );
    }
    // Ticket #60: each of these already committed inside `dispatchOne`'s own
    // transaction (dispatcher.ts) before `dispatchPending` returned it here —
    // this loop only ever reads back what is already durable.
    for (const event of dispatched) {
      deps.liveUpdates.publish({
        type: "event.recorded",
        projectId: event.projectId,
        occurredAt: event.envelope.occurredAt,
        payload: summarizeEventEnvelope(event.envelope),
      });
    }
  } catch (error) {
    process.stderr.write(
      `jarvis-engine: dispatching pending outbox rows failed: ${String(error)}\n`,
    );
  }

  for (const delivery of claimDueDeliveries(
    deps.db,
    deps.clock,
    deps.deliveryLeaseMs,
    undefined,
    deps.ids,
  )) {
    try {
      const outcome = await deps.consumer.consumeAsync(delivery);
      process.stderr.write(
        `jarvis-engine: delivery consumed project=${delivery.projectId} ` +
          `moduleInstance=${delivery.moduleInstanceId} event=${delivery.eventId} ` +
          `status=${outcome.status} redelivered=${String(outcome.redelivered)}\n`,
      );
      // Ticket #60: `null` on a redelivery — no new Execution was created,
      // so there is nothing new to report (`consume()`'s doc comment). Also
      // already committed, for the same reason the dispatch side above is.
      if (outcome.executionSummary !== null) {
        const summary = outcome.executionSummary;
        deps.liveUpdates.publish({
          type: "execution.changed",
          projectId: delivery.projectId,
          occurredAt: summary.completedAt ?? summary.createdAt,
          payload: summary,
        });
      }
    } catch (error) {
      // A delivery this loop cannot consume must not take the whole engine
      // down with it (no other tick depends on this one) or strand every
      // other Delivery behind it — logged and retried next tick instead.
      process.stderr.write(
        `jarvis-engine: consuming delivery project=${delivery.projectId} ` +
          `moduleInstance=${delivery.moduleInstanceId} event=${delivery.eventId} failed: ` +
          `${String(error)}\n`,
      );
    }
  }
}

/** Returns a function that stops the loop; call it before closing the database. */
export function startEventLoop(deps: EventLoopDependencies, intervalMs = 200): () => void {
  let inFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    // An async handler must not be started twice while the previous tick is
    // still waiting for it; the Delivery remains unconsumed until its one
    // terminal transaction commits.
    if (inFlight !== undefined) return;
    inFlight = tickEventLoop(deps)
      .catch((error: unknown) => {
        process.stderr.write(`jarvis-engine: event loop tick failed: ${String(error)}\n`);
      })
      .finally(() => {
        inFlight = undefined;
      });
  }, intervalMs);
  // Never keeps the process alive on its own — only `app.listen()` and open
  // connections do that, same as every other engine background timer.
  timer.unref();
  return () => clearInterval(timer);
}

const MAX_DELIVERIES_PER_TICK = 50;

export function claimDueDeliveries(
  db: Database.Database,
  clock: Clock,
  leaseMs = DEFAULT_DELIVERY_LEASE_MS,
  limit = MAX_DELIVERIES_PER_TICK,
  ids: Pick<IdGenerator, "next"> = new SystemIdGenerator(),
): readonly ClaimedDelivery[] {
  return db.transaction(() => {
    const now = clock.now();
    const leaseOwner = `delivery-${ids.next()}`;
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const rows = db
      .prepare(
        `SELECT deliveries.id, deliveries.project_id AS projectId,
                deliveries.module_instance_id AS moduleInstanceId,
                deliveries.module_id AS moduleId, deliveries.event_id AS eventId,
                dead_letters.delivery_id IS NOT NULL AS replayed
         FROM deliveries
         LEFT JOIN dead_letters ON dead_letters.delivery_id = deliveries.id
         WHERE deliveries.consumed_at IS NULL
           AND (deliveries.next_attempt_at IS NULL OR deliveries.next_attempt_at <= @now)
           AND (deliveries.lease_expires_at IS NULL OR deliveries.lease_expires_at <= @now)
         ORDER BY deliveries.created_at
         LIMIT @limit`,
      )
      .all({ now: now.toISOString(), limit }) as {
      readonly id: string;
      readonly projectId: string;
      readonly moduleInstanceId: string;
      readonly moduleId: string;
      readonly eventId: string;
      readonly replayed: number;
    }[];
    const claim = db.prepare(
      `UPDATE deliveries
       SET lease_owner = @leaseOwner, lease_expires_at = @leaseExpiresAt
       WHERE id = @id AND consumed_at IS NULL
         AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
         AND (lease_expires_at IS NULL OR lease_expires_at <= @now)`,
    );
    return rows.flatMap((row) => {
      const claimed = claim.run({
        id: row.id,
        now: now.toISOString(),
        leaseOwner,
        leaseExpiresAt,
      });
      return claimed.changes === 1 ? [{ ...row, leaseOwner, replayed: row.replayed === 1 }] : [];
    });
  })();
}
