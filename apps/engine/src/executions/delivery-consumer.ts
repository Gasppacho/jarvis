import type Database from "better-sqlite3";
import type { Clock } from "../../../../packages/kernel/src/clock.js";
import type { IdGenerator } from "../../../../packages/kernel/src/id-generator.js";
import type {
  EventEnvelope,
  EventEnvelopeSubject,
} from "../../../../packages/eventing/src/envelope.js";
import { EventPublisher, type PublishEventInput } from "../events/publisher.js";
import { EngineError } from "../errors.js";
import { failpoint } from "../test-support/failpoint.js";
import type { LedgerExecutionSummary } from "./ledger.js";

/** See apps/engine/src/events/dispatcher.ts's identical declaration for why
 * this exists and how tsup.config.ts's `define` makes it eliminate the
 * failpoint calls below from the production bundle. */
declare const __JARVIS_TEST_HOOKS__: boolean | undefined;

/**
 * Ticket #57 (docs/architecture/PERSISTENCE.md "Consume and publish";
 * docs/architecture/EVENTS.md "Delivery semantics"): turns one claimed
 * Delivery into exactly one Module handler invocation, recorded in the
 * Inbox and the Execution Ledger.
 *
 * Composition-root wiring: NOT wired into `apps/engine/src/main.ts` /
 * `http/server.ts`. Nothing in a running engine ever calls
 * `EventPublisher.publish` (no HTTP route accepts an inbound Event, and
 * every official Module Package's entrypoint under packages/modules is still
 * a build-time stub) or `OutboxDispatcher.dispatchPending` (no scheduled
 * loop exists). Wiring `DeliveryConsumer` in now would add a
 * `ModuleHandlerLookup` with no real handler to register and no caller that
 * could ever reach it — dead code with nothing to demonstrate it against.
 * The Application Harness test below is the only reachable seam until a
 * later ticket gives a real Module a real handler and an entry point that
 * publishes an Event.
 */

/** The Module SDK vocabulary (packages/module-sdk/CONTEXT.md "Handler",
 * "Module Context") kept local to the engine, the same way `dispatcher.ts`
 * keeps `OpenSubscriptionsPort` a structural mirror instead of an import:
 * there is exactly one caller of this shape today, so a separate package is
 * not yet worth its build/tsconfig/vitest scaffolding. Promote it into
 * `packages/module-sdk` when a real Module Package needs to implement
 * `ModuleHandler` itself. */
export interface ModuleHandlerPublishInput {
  readonly type: string;
  readonly version: number;
  readonly kind: "request" | "fact";
  readonly producer: { readonly moduleId: string; readonly moduleInstanceId: string };
  readonly subject: EventEnvelopeSubject;
  readonly repositoryId?: string;
  readonly target?: PublishEventInput["target"];
  readonly idempotencyKey?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly metadata?: PublishEventInput["metadata"];
}

export interface ModuleHandlerContext {
  readonly projectId: string;
  readonly moduleInstanceId: string;
  readonly event: EventEnvelope;
  /** Scoped to the module's own tables by convention
   * (docs/architecture/PERSISTENCE.md "Logical ownership"); nothing enforces
   * that at this layer, the same way it isn't enforced for a real Module's
   * migration today. */
  readonly db: Database.Database;
  /** Publishes within the ambient consume-and-publish transaction. Always
   * carries the consumed event as causation and its correlationId — a
   * handler cannot override either, which is what makes acceptance
   * criterion 6 (causation/correlation) a pipeline guarantee rather than a
   * per-handler discipline. */
  readonly publish: (input: ModuleHandlerPublishInput) => EventEnvelope;
}

export type ModuleHandler = (ctx: ModuleHandlerContext) => unknown;

/** Resolves a Module's Handler by Module Package id; `undefined` when none is
 * registered. Mirrors `OpenSubscriptionsPort`'s function-port shape. */
export type ModuleHandlerLookup = (moduleId: string) => ModuleHandler | undefined;

export interface ClaimedDelivery {
  readonly projectId: string;
  readonly moduleInstanceId: string;
  readonly moduleId: string;
  readonly eventId: string;
}

export interface ConsumeResult {
  /** `null` on a redelivery: no second Execution is created (acceptance
   * criterion 3), so there is no new id to report. */
  readonly executionId: string | null;
  readonly status: "completed" | "failed";
  readonly result: unknown;
  readonly redelivered: boolean;
  /** Ticket #60: the Ledger row this call just committed, in the REST
   * `ExecutionSummary` shape plus the input Event's correlation — `null` on
   * a redelivery, since no new Execution was created and there is nothing
   * new to report as a Live Update. Built from the exact values just written
   * to `executions`, never a second read, so it cannot drift from the row
   * this call committed. */
  readonly executionSummary: (LedgerExecutionSummary & { readonly correlationId: string }) | null;
}

interface InboxRow {
  readonly status: "completed" | "failed";
  readonly result: string;
}

/**
 * Ticket #57: one claimed Delivery in, one terminal Execution and Inbox
 * record out. See the module doc comment above for why this is not wired
 * into the composition root yet.
 */
export class DeliveryConsumer {
  public constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly publisher: EventPublisher,
    private readonly handlers: ModuleHandlerLookup,
  ) {}

  public consume(delivery: ClaimedDelivery): ConsumeResult {
    // This SELECT is a plain read outside any transaction: it is safe today
    // only because better-sqlite3 is synchronous and single-process. The
    // real safety net for two callers racing the same (project, module
    // instance, event) pair is the unique index
    // `inbox_project_id_module_instance_id_event_id_unique`
    // (0007_inbox_execution_ledger.sql), not this check. If that race ever
    // occurs, the loser's INSERT INTO inbox violates the constraint and
    // lands in the handler-failure path above (or, per Fix 1, the labeled
    // `system.internal-error` if recording the failure also fails) — it is
    // not currently detected and treated as a redelivery.
    const existing = this.db
      .prepare(
        `SELECT status, result FROM inbox
         WHERE project_id = @projectId AND module_instance_id = @moduleInstanceId AND event_id = @eventId`,
      )
      .get(delivery) as InboxRow | undefined;
    if (existing !== undefined) {
      // Redelivery: the recorded terminal result is returned, the side
      // effect is not re-applied and no second Execution is created
      // (acceptance criterion 3).
      return {
        executionId: null,
        status: existing.status,
        result: JSON.parse(existing.result) as unknown,
        redelivered: true,
        executionSummary: null,
      };
    }

    const envelope = this.requireEnvelope(delivery);
    const handler = this.handlers(delivery.moduleId);
    const executionId = `exec_${this.ids.next()}`;
    const startedAt = this.clock.now().toISOString();

    try {
      if (handler === undefined) {
        throw new Error(`No handler registered for Module ${delivery.moduleId}.`);
      }

      const { handlerResult: result, executionRow } = this.db.transaction(() => {
        // Consume-and-publish (docs/architecture/PERSISTENCE.md): the
        // handler mutates its own Module state and publishes outgoing
        // Outbox rows through `ctx.publish`, all inside this one
        // transaction. A throw anywhere in here — including inside the
        // handler — rolls back everything below, so none of Inbox
        // insertion, Module state mutation, Execution insertion or Outbox
        // rows are applied (acceptance criterion 2).
        const handlerResult = handler(this.buildContext(delivery, envelope));

        // Ticket #58 acceptance criterion 3: a declared boundary inside the
        // handler's own transaction, after the handler mutated state but
        // before any of Execution, Inbox or Delivery-consumed is written and
        // before this transaction's COMMIT. A process killed here leaves the
        // whole transaction — including the handler's own state mutation —
        // rolled back: no partial handler effect survives.
        if (typeof __JARVIS_TEST_HOOKS__ === "undefined" || __JARVIS_TEST_HOOKS__) {
          failpoint("before-handler-commit");
        }

        const executionRow = this.insertExecution(
          executionId,
          delivery,
          envelope,
          "completed",
          startedAt,
          null,
        );
        this.insertInbox(delivery, "completed", handlerResult);
        this.markDeliveryConsumed(delivery);

        return { handlerResult, executionRow };
      })();

      // Ticket #58 acceptance criterion 4: a declared boundary right after
      // the handler's transaction commits (state, Execution, Inbox and
      // Delivery-consumed are all durable at this point — PERSISTENCE.md's
      // "Consume and publish" commits them together) and before this method
      // acknowledges the Delivery to its caller. A process killed here still
      // leaves everything above committed, so a subsequent redelivery of the
      // same (project, module instance, event) finds the Inbox record and
      // returns its recorded result without re-running the handler.
      if (typeof __JARVIS_TEST_HOOKS__ === "undefined" || __JARVIS_TEST_HOOKS__) {
        failpoint("after-handler-commit");
      }

      return {
        executionId,
        status: "completed",
        result,
        redelivered: false,
        executionSummary: { ...executionRow, correlationId: envelope.correlationId },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Deliberately a second, separate transaction: it must commit even
      // though the attempt above rolled back, and it is the only place the
      // failed Execution and its Inbox record are written (acceptance
      // criterion 2's "leaves none of them applied and the Execution
      // recorded as failed"; #17's retries/backoff/dead letters are out of
      // scope — this is the terminal record, not a retry schedule).
      let executionRow: LedgerExecutionSummary;
      try {
        executionRow = this.db.transaction(() => {
          const row = this.insertExecution(
            executionId,
            delivery,
            envelope,
            "failed",
            startedAt,
            message,
          );
          this.insertInbox(delivery, "failed", { error: message });
          this.markDeliveryConsumed(delivery);
          return row;
        })();
      } catch (recordingError) {
        // A failure while recording a failure (constraint violation, disk
        // error) must not crash the caller with a raw, unlabeled exception
        // and must not lose the original handler failure (`message`): the
        // Delivery is left with `consumed_at` unset, unresolved — a loud,
        // clearly labeled failure rather than a silent strand (no retry
        // schedule exists yet — #17).
        const recordingMessage =
          recordingError instanceof Error ? recordingError.message : String(recordingError);
        throw new EngineError(
          "system.internal-error",
          500,
          `Recording the failed Execution for Delivery (project ${delivery.projectId}, module instance ${delivery.moduleInstanceId}, event ${delivery.eventId}) itself failed: ${recordingMessage}. Original handler failure: ${message}`,
          {
            projectId: delivery.projectId,
            moduleInstanceId: delivery.moduleInstanceId,
            eventId: delivery.eventId,
            handlerError: message,
            recordingError: recordingMessage,
          },
        );
      }

      return {
        executionId,
        status: "failed",
        result: { error: message },
        redelivered: false,
        executionSummary: { ...executionRow, correlationId: envelope.correlationId },
      };
    }
  }

  private buildContext(delivery: ClaimedDelivery, envelope: EventEnvelope): ModuleHandlerContext {
    return {
      projectId: delivery.projectId,
      moduleInstanceId: delivery.moduleInstanceId,
      event: envelope,
      db: this.db,
      publish: (input) =>
        this.publisher.publish({
          type: input.type,
          version: input.version,
          kind: input.kind,
          producer: input.producer,
          subject: input.subject,
          payload: input.payload,
          projectId: delivery.projectId,
          // Always the consumed event's own chain (acceptance criterion 6):
          // a handler has no field to override either with.
          correlationId: envelope.correlationId,
          causationId: envelope.id,
          // Conditionally spread rather than passed through directly: with
          // `exactOptionalPropertyTypes`, an always-present `target: undefined`
          // key is not assignable to `PublishEventInput`'s optional `target?`.
          ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
          ...(input.target === undefined ? {} : { target: input.target }),
          ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        }),
    };
  }

  /** Returns the row just written, in the REST Ledger shape — ticket #60
   * builds the stream's `execution.changed` Live Update from this return
   * value rather than a second read of `executions`. */
  private insertExecution(
    id: string,
    delivery: ClaimedDelivery,
    envelope: EventEnvelope,
    status: "completed" | "failed",
    startedAt: string,
    error: string | null,
  ): LedgerExecutionSummary {
    const completedAt = this.clock.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO executions
           (id, project_id, module_instance_id, module_id, input_event_id, attempt, status, error, started_at, completed_at, created_at)
         VALUES
           (@id, @projectId, @moduleInstanceId, @moduleId, @inputEventId, 1, @status, @error, @startedAt, @completedAt, @startedAt)`,
      )
      .run({
        id,
        projectId: delivery.projectId,
        moduleInstanceId: delivery.moduleInstanceId,
        moduleId: delivery.moduleId,
        inputEventId: envelope.id,
        status,
        error,
        startedAt,
        completedAt,
      });
    return {
      id,
      projectId: delivery.projectId,
      moduleInstanceId: delivery.moduleInstanceId,
      status,
      attempt: 1,
      createdAt: startedAt,
      completedAt,
      inputEventId: envelope.id,
    };
  }

  private insertInbox(
    delivery: ClaimedDelivery,
    status: "completed" | "failed",
    result: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO inbox (project_id, module_instance_id, event_id, status, attempt, result, created_at)
         VALUES (@projectId, @moduleInstanceId, @eventId, @status, 1, @result, @createdAt)`,
      )
      .run({
        projectId: delivery.projectId,
        moduleInstanceId: delivery.moduleInstanceId,
        eventId: delivery.eventId,
        status,
        result: JSON.stringify(result ?? null),
        createdAt: this.clock.now().toISOString(),
      });
  }

  private markDeliveryConsumed(delivery: ClaimedDelivery): void {
    this.db
      .prepare(
        `UPDATE deliveries SET consumed_at = @now
         WHERE project_id = @projectId AND module_instance_id = @moduleInstanceId AND event_id = @eventId`,
      )
      .run({
        projectId: delivery.projectId,
        moduleInstanceId: delivery.moduleInstanceId,
        eventId: delivery.eventId,
        now: this.clock.now().toISOString(),
      });
  }

  private requireEnvelope(delivery: ClaimedDelivery): EventEnvelope {
    // Project-scoped by both `id` and `project_id` (AGENTS.md invariant 9:
    // "Every event is scoped by projectId; cross-project delivery is
    // forbidden"): a ClaimedDelivery naming a Project that does not own this
    // event finds no row here and fails loudly, rather than the write path
    // trusting caller discipline alone.
    const row = this.db
      .prepare(`SELECT envelope FROM events WHERE id = @eventId AND project_id = @projectId`)
      .get({ eventId: delivery.eventId, projectId: delivery.projectId }) as
      { envelope: string } | undefined;
    if (row === undefined) {
      throw new Error(
        `No journaled event ${delivery.eventId} in Project ${delivery.projectId} to consume.`,
      );
    }
    return JSON.parse(row.envelope) as EventEnvelope;
  }
}
