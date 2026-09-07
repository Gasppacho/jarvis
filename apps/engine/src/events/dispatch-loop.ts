import type Database from "better-sqlite3";
import type { ClaimedDelivery, DeliveryConsumer } from "../executions/delivery-consumer.js";
import type { LiveUpdatePort } from "../stream/hub.js";
import { summarizeEventEnvelope } from "./timeline.js";
import type { OutboxDispatcher } from "./dispatcher.js";

export interface EventLoopDependencies {
  readonly db: Database.Database;
  readonly dispatcher: OutboxDispatcher;
  readonly consumer: DeliveryConsumer;
  /** Ticket #60: fed one Live Update per journaled Event and per recorded
   * Execution, always after that row's own transaction has already
   * committed (see the two call sites below) — never before, so a rolled
   * back attempt can never produce one. */
  readonly liveUpdates: LiveUpdatePort;
}

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
 * Fixed interval, no backoff or retry classification: #17 owns that. A
 * handler failure is already terminal per ticket #57 (the Delivery is marked
 * consumed either way), so this loop never retries one — it only guarantees
 * that a Delivery nothing has consumed yet eventually is.
 */
export function tickEventLoop(deps: EventLoopDependencies): void {
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

  for (const delivery of listUnconsumedDeliveries(deps.db)) {
    try {
      const outcome = deps.consumer.consume(delivery);
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
  const timer = setInterval(() => tickEventLoop(deps), intervalMs);
  // Never keeps the process alive on its own — only `app.listen()` and open
  // connections do that, same as every other engine background timer.
  timer.unref();
  return () => clearInterval(timer);
}

function listUnconsumedDeliveries(db: Database.Database): readonly ClaimedDelivery[] {
  return db
    .prepare(
      `SELECT project_id AS projectId, module_instance_id AS moduleInstanceId,
              module_id AS moduleId, event_id AS eventId
       FROM deliveries WHERE consumed_at IS NULL ORDER BY created_at`,
    )
    .all() as ClaimedDelivery[];
}
