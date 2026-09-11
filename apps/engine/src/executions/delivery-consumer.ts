import type Database from "better-sqlite3";
import type { Clock } from "../../../../packages/kernel/src/clock.js";
import type { IdGenerator } from "../../../../packages/kernel/src/id-generator.js";
import type { EventEnvelope } from "../../../../packages/eventing/src/envelope.js";
import type {
  ModuleConfigurationLookup,
  ModuleCapabilityLookup,
  ModuleHandlerContext,
  ModuleHandlerCapabilities,
  ModuleHandlerLookup,
  ModuleHandlerPublishInput,
  ModuleRepositoryDefaultBranchLookup,
} from "../../../../packages/module-sdk/src/index.js";

export type ModulePublishedContract = Pick<ModuleHandlerPublishInput, "type" | "version" | "kind">;

export type ModulePublishedContractsLookup = (
  moduleId: string,
) => readonly ModulePublishedContract[] | undefined;

import { EventPublisher, type PublishEventInput } from "../events/publisher.js";
import { EngineError } from "../errors.js";
import { failpoint } from "../test-support/failpoint.js";
import { computeRetrySchedule } from "../../../../packages/eventing/src/retry-policy.js";
import { ExecutionCheckpointStore } from "./checkpoints.js";
import { STATUS_TO_API, type LedgerExecutionSummary } from "./ledger.js";

export interface HandlerFailureClassification {
  readonly code: string;
  readonly retryable: boolean;
  readonly message: string;
}

const INTERNAL_HANDLER_FAILURE_CODE = "system.internal-error";

/**
 * Pure failure seam for the retry/dead-letter work under #17. The consumer
 * still records its existing terminal result; later orchestration can use
 * this classification without giving the classifier access to runtime state.
 */
export function classifyHandlerFailure(error: unknown): HandlerFailureClassification {
  const message = cleanHandlerFailureMessage(readFailureMessage(error));
  const structuredFailure = readStructuredFailure(error);
  if (structuredFailure !== undefined) {
    return { ...structuredFailure, message };
  }

  const code = error instanceof EngineError ? readErrorCode(error) : undefined;
  return {
    code: code ?? INTERNAL_HANDLER_FAILURE_CODE,
    retryable: inferredRetryability(code, message),
    message,
  };
}

/** See apps/engine/src/events/dispatcher.ts's identical declaration for why
 * this exists and how tsup.config.ts's `define` makes it eliminate the
 * failpoint calls below from the production bundle. */
declare const __JARVIS_TEST_HOOKS__: boolean | undefined;

/**
 * Ticket #57 (docs/architecture/PERSISTENCE.md "Consume and publish";
 * docs/architecture/EVENTS.md "Delivery semantics"): turns one claimed
 * Delivery attempt into a durable Execution. Terminal attempts also write
 * the Inbox; retryable failures leave the Delivery available for its due
 * next attempt.
 *
 * Composition-root wiring in `apps/engine/src/main.ts` supplies the handler
 * and project-scoped configuration lookups. The Application Harness reaches
 * the same consumer through the test-only inbound trigger; production module
 * adapters use the same Outbox/Inbox/Execution transaction.
 */

/** The Module SDK handler contract is shared with real Module Packages. */
export type {
  ModuleConfiguration,
  ModuleCapabilityLookup,
  ModuleHandlerCapabilities,
  ModuleConfigurationLookup,
  ModuleHandler,
  ModuleHandlerContext,
  ModuleHandlerLookup,
  ModuleHandlerPublishInput,
  ModuleRepositoryDefaultBranchLookup,
} from "../../../../packages/module-sdk/src/index.js";

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
  readonly status: "completed" | "failed" | "cancelled" | "timed-out";
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
  readonly status: "completed" | "failed" | "cancelled" | "timed_out";
  readonly result: string;
}

interface SuccessfulConsumption {
  readonly handlerResult: unknown;
  readonly executionRow: LedgerExecutionSummary;
}

export interface ExecutionCancellationPort {
  cancelExecution(executionId: unknown): LedgerExecutionSummary;
}

interface ActiveExecution {
  readonly projectId: string;
  readonly controller: AbortController;
}

interface ExecutionRow {
  readonly id: string;
  readonly project_id: string;
  readonly module_instance_id: string;
  readonly status: string;
  readonly attempt: number;
  readonly created_at: string;
  readonly completed_at: string | null;
  readonly input_event_id: string;
}

/**
 * Ticket #57: one claimed Delivery in, one terminal Execution and Inbox
 * record out. The handler's own state changes and published Outbox rows share
 * the same transaction as the terminal Inbox and Execution records.
 */
export class DeliveryConsumer implements ExecutionCancellationPort {
  private readonly activeExecutions = new Map<string, ActiveExecution>();
  private readonly checkpointStore: ExecutionCheckpointStore;

  public constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly publisher: EventPublisher,
    private readonly handlers: ModuleHandlerLookup,
    private readonly configurations: ModuleConfigurationLookup = () => ({}),
    private readonly repositoryDefaultBranches: ModuleRepositoryDefaultBranchLookup = () => "main",
    private readonly publishedContracts: ModulePublishedContractsLookup = () => undefined,
    private readonly capabilities: ModuleCapabilityLookup = () => ({}),
    checkpointStore?: ExecutionCheckpointStore,
    private readonly retryRandom: () => number = Math.random,
  ) {
    this.checkpointStore = checkpointStore ?? new ExecutionCheckpointStore(db);
  }

  public cancelExecution(executionId: unknown): LedgerExecutionSummary {
    if (typeof executionId !== "string" || executionId.length === 0) {
      throw new EngineError(
        "execution.not-found",
        404,
        "No Execution with the requested ID exists.",
      );
    }

    const summary = this.db.transaction(() => {
      const current = readExecutionSummary(this.db, executionId);
      if (current === undefined) {
        throw new EngineError(
          "execution.not-found",
          404,
          "No Execution with the requested ID exists.",
        );
      }
      if (current.status === "cancelling") return current;
      if (current.status !== "running" || !this.activeExecutions.has(executionId)) {
        throw new EngineError(
          "execution.not-cancellable",
          409,
          `Execution ${executionId} is not in a cancellable running state.`,
        );
      }

      const written = this.db
        .prepare(
          `UPDATE executions
           SET status = 'cancelling'
           WHERE id = @id AND status = 'running'
           RETURNING id, project_id, module_instance_id, status, attempt, created_at,
                     completed_at, input_event_id`,
        )
        .get({ id: executionId }) as ExecutionRow | undefined;
      if (written === undefined) {
        throw new EngineError(
          "execution.not-cancellable",
          409,
          `Execution ${executionId} is not in a cancellable running state.`,
        );
      }
      return toExecutionSummary(written);
    })();

    // The durable transition is committed before the handler is interrupted.
    this.activeExecutions.get(executionId)?.controller.abort();
    return summary;
  }

  /**
   * Compatibility contract for existing synchronous Module callers. When the
   * handler returns a Promise, the runtime result is awaitable; callers that
   * need an explicit async boundary should use `consumeAsync`.
   */
  public consume(delivery: ClaimedDelivery): ConsumeResult;
  public consume(delivery: ClaimedDelivery): ConsumeResult | Promise<ConsumeResult> {
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
        status: inboxStatusToApi(existing.status),
        result: JSON.parse(existing.result) as unknown,
        redelivered: true,
        executionSummary: null,
      };
    }

    const envelope = this.requireEnvelope(delivery);
    const existingDeadLetter = this.readDeadLetter(delivery);
    if (existingDeadLetter !== undefined) {
      return {
        executionId: null,
        status: "failed",
        result: { error: { code: existingDeadLetter.code, message: existingDeadLetter.message } },
        redelivered: true,
        executionSummary: null,
      };
    }
    const attempt = this.readDeliveryAttempt(delivery);
    const handler = this.handlers(delivery.moduleId);
    const executionId = `exec_${this.ids.next()}`;
    const startedAt = this.clock.now().toISOString();
    const bufferedPublications: EventEnvelope[] = [];
    const failurePublications: EventEnvelope[] = [];

    if (handler === undefined) {
      return this.recordFailure(
        delivery,
        envelope,
        executionId,
        startedAt,
        new Error(`No handler registered for Module ${delivery.moduleId}.`),
        failurePublications,
        attempt,
      );
    }

    const controller = new AbortController();
    let transactionOpen = true;
    let promiseResult: PromiseLike<unknown> | undefined;
    let runningExecutionCommitted = false;
    let handlerCapabilities: ModuleHandlerCapabilities | undefined;

    try {
      const transactionResult = this.db.transaction(() => {
        // Create the running Ledger row before invoking the handler so a
        // synchronous Module can record durable checkpoints too. Async
        // handlers use the same row after this transaction commits.
        this.insertExecution(executionId, delivery, envelope, "running", startedAt, null, attempt);
        handlerCapabilities = this.capabilities(
          delivery.projectId,
          delivery.moduleInstanceId,
          delivery.moduleId,
        );
        const handlerResult = handler(
          this.buildContext(
            delivery,
            envelope,
            executionId,
            () => transactionOpen,
            bufferedPublications,
            failurePublications,
            controller.signal,
            handlerCapabilities,
          ),
        );
        if (isPromiseLike(handlerResult)) {
          // better-sqlite3 rejects a transaction callback that returns a
          // promise. Store it and return synchronously so this transaction
          // commits; it is awaited only after the commit, then terminal
          // records are written in a new short transaction.
          promiseResult = handlerResult;
          return undefined;
        }

        return this.commitSuccessfulConsumption(
          delivery,
          envelope,
          executionId,
          startedAt,
          handlerResult,
          bufferedPublications,
          handlerCapabilities,
          attempt,
        );
      })();
      transactionOpen = false;

      if (promiseResult !== undefined) {
        runningExecutionCommitted = true;
        this.activeExecutions.set(executionId, {
          projectId: delivery.projectId,
          controller,
        });
        return Promise.resolve(promiseResult)
          .then(
            (result) =>
              this.commitAsyncSuccess(
                delivery,
                envelope,
                executionId,
                startedAt,
                result,
                bufferedPublications,
                failurePublications,
                controller.signal,
                handlerCapabilities,
                attempt,
              ),
            (error) =>
              controller.signal.aborted
                ? this.recordCancelled(
                    delivery,
                    envelope,
                    executionId,
                    startedAt,
                    failurePublications,
                    attempt,
                    true,
                  )
                : this.recordFailure(
                    delivery,
                    envelope,
                    executionId,
                    startedAt,
                    error,
                    failurePublications,
                    attempt,
                    true,
                  ),
          )
          .finally(() => this.activeExecutions.delete(executionId));
      }

      const { handlerResult: result, executionRow } = transactionResult as SuccessfulConsumption;
      this.failAfterHandlerCommit();
      return this.completedResult(executionId, envelope, result, executionRow);
    } catch (error) {
      transactionOpen = false;
      return this.recordFailure(
        delivery,
        envelope,
        executionId,
        startedAt,
        error,
        failurePublications,
        attempt,
        runningExecutionCommitted,
      );
    }
  }

  public async consumeAsync(delivery: ClaimedDelivery): Promise<ConsumeResult> {
    return this.consume(delivery);
  }

  private commitAsyncSuccess(
    delivery: ClaimedDelivery,
    envelope: EventEnvelope,
    executionId: string,
    startedAt: string,
    result: unknown,
    bufferedPublications: readonly EventEnvelope[],
    failurePublications: readonly EventEnvelope[],
    signal: AbortSignal,
    capabilities: ModuleHandlerCapabilities | undefined,
    attempt: number,
  ): ConsumeResult {
    if (signal.aborted) {
      return this.recordCancelled(
        delivery,
        envelope,
        executionId,
        startedAt,
        failurePublications,
        attempt,
        true,
      );
    }
    if (isCancelledResult(result)) {
      return this.recordCancelled(
        delivery,
        envelope,
        executionId,
        startedAt,
        failurePublications,
        attempt,
        true,
      );
    }
    if (isTimedOutResult(result)) {
      return this.recordTimedOut(
        delivery,
        envelope,
        executionId,
        startedAt,
        failurePublications,
        attempt,
        true,
      );
    }

    if (
      (typeof __JARVIS_TEST_HOOKS__ === "undefined" || __JARVIS_TEST_HOOKS__) &&
      process.env["JARVIS_FAILPOINT"] === "after-github-create-before-external-mapping"
    ) {
      failpoint("after-github-create-before-external-mapping");
    }

    if (
      (typeof __JARVIS_TEST_HOOKS__ === "undefined" || __JARVIS_TEST_HOOKS__) &&
      process.env["JARVIS_FAILPOINT"] === "after-external-mapping-before-fact"
    ) {
      this.db.transaction(() => capabilities?.externalMappings?.flushPending?.())();
      failpoint("after-external-mapping-before-fact");
    }

    const { executionRow } = this.db.transaction(() => {
      capabilities?.externalMappings?.flushPending?.();
      for (const publication of bufferedPublications) {
        this.insertBufferedPublication(publication);
      }
      if (typeof __JARVIS_TEST_HOOKS__ === "undefined" || __JARVIS_TEST_HOOKS__) {
        failpoint("before-handler-commit");
      }
      const row = this.updateExecution(executionId, "completed", null);
      this.insertInbox(delivery, "completed", result, attempt);
      this.markDeliveryConsumed(delivery, attempt);
      return { executionRow: row };
    })();
    this.failAfterHandlerCommit();
    return this.completedResult(executionId, envelope, result, executionRow);
  }

  private commitSuccessfulConsumption(
    delivery: ClaimedDelivery,
    envelope: EventEnvelope,
    executionId: string,
    startedAt: string,
    handlerResult: unknown,
    bufferedPublications: readonly EventEnvelope[],
    capabilities: ModuleHandlerCapabilities | undefined,
    attempt: number,
  ): SuccessfulConsumption {
    capabilities?.externalMappings?.flushPending?.();
    for (const publication of bufferedPublications) {
      this.insertBufferedPublication(publication);
    }

    // Ticket #58 acceptance criterion 3: this boundary is inside the short
    // terminal transaction. For a synchronous handler it still includes the
    // handler's own state mutation; for an async handler it includes every
    // buffered publication and all terminal records.
    if (typeof __JARVIS_TEST_HOOKS__ === "undefined" || __JARVIS_TEST_HOOKS__) {
      failpoint("before-handler-commit");
    }

    const executionRow = this.updateExecution(executionId, "completed", null);
    this.insertInbox(delivery, "completed", handlerResult, attempt);
    this.markDeliveryConsumed(delivery, attempt);
    return { handlerResult, executionRow };
  }

  private completedResult(
    executionId: string,
    envelope: EventEnvelope,
    result: unknown,
    executionRow: LedgerExecutionSummary,
  ): ConsumeResult {
    return {
      executionId,
      status: "completed",
      result,
      redelivered: false,
      executionSummary: { ...executionRow, correlationId: envelope.correlationId },
    };
  }

  private recordFailure(
    delivery: ClaimedDelivery,
    envelope: EventEnvelope,
    executionId: string,
    startedAt: string,
    error: unknown,
    failurePublications: readonly EventEnvelope[],
    attempt: number,
    running = false,
  ): ConsumeResult {
    const classification = classifyHandlerFailure(error);
    const message = classification.message;
    const structuredFailure = readStructuredFailure(error);
    const result =
      structuredFailure !== undefined
        ? { error: { ...structuredFailure, message } }
        : error instanceof EngineError
          ? { error: { code: error.code, message } }
          : { error: message };
    // Deliberately a second, separate transaction: it must commit even
    // though the attempt above rolled back, and it is the only place the
    // failed Execution and retry or terminal outcome are written.
    let executionRow: LedgerExecutionSummary;
    try {
      executionRow = this.db.transaction(() => {
        for (const publication of failurePublications) {
          this.insertBufferedPublication(publication);
        }
        const row = running
          ? this.updateExecution(executionId, "failed", message)
          : this.insertExecution(
              executionId,
              delivery,
              envelope,
              "failed",
              startedAt,
              message,
              attempt,
            );
        const schedule = classification.retryable
          ? computeRetrySchedule(attempt, this.retryRandom)
          : undefined;
        if (schedule !== undefined && !schedule.exhausted) {
          this.scheduleRetry(
            delivery,
            attempt,
            new Date(this.clock.now().getTime() + schedule.delayMs).toISOString(),
          );
        } else if (schedule?.exhausted === true) {
          this.insertDeadLetter(delivery, "delivery.retry-exhausted", message, attempt, row.id);
          this.markDeliveryConsumed(delivery, attempt);
        } else {
          this.insertDeadLetter(delivery, classification.code, message, 1, row.id);
          this.markDeliveryConsumed(delivery, attempt);
        }
        return row;
      })();
    } catch (recordingError) {
      // A failure while recording a failure (constraint violation, disk
      // error) must not crash the caller with a raw, unlabeled exception
      // and must not lose the original handler failure (`message`): the
      // Delivery is left with `consumed_at` unset when this transaction also
      // fails; #159 bounds and dead-letters that exceptional path.
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
      result,
      redelivered: false,
      executionSummary: { ...executionRow, correlationId: envelope.correlationId },
    };
  }

  private recordCancelled(
    delivery: ClaimedDelivery,
    envelope: EventEnvelope,
    executionId: string,
    startedAt: string,
    failurePublications: readonly EventEnvelope[],
    attempt: number,
    running: boolean,
  ): ConsumeResult {
    const executionRow = this.db.transaction(() => {
      for (const publication of failurePublications) {
        this.insertBufferedPublication(publication);
      }
      const row = running
        ? this.updateExecution(executionId, "cancelled", null)
        : this.insertExecution(
            executionId,
            delivery,
            envelope,
            "cancelled",
            startedAt,
            null,
            attempt,
          );
      this.insertInbox(delivery, "cancelled", { cancelled: true }, attempt);
      this.markDeliveryConsumed(delivery, attempt);
      return row;
    })();
    this.failAfterHandlerCommit();
    return {
      executionId,
      status: "cancelled",
      result: { cancelled: true },
      redelivered: false,
      executionSummary: { ...executionRow, correlationId: envelope.correlationId },
    };
  }

  private recordTimedOut(
    delivery: ClaimedDelivery,
    envelope: EventEnvelope,
    executionId: string,
    startedAt: string,
    failurePublications: readonly EventEnvelope[],
    attempt: number,
    running: boolean,
  ): ConsumeResult {
    const executionRow = this.db.transaction(() => {
      for (const publication of failurePublications) {
        this.insertBufferedPublication(publication);
      }
      const row = running
        ? this.updateExecution(executionId, "timed_out", null)
        : this.insertExecution(
            executionId,
            delivery,
            envelope,
            "timed_out",
            startedAt,
            null,
            attempt,
          );
      this.insertInbox(delivery, "timed_out", { timedOut: true }, attempt);
      this.markDeliveryConsumed(delivery, attempt);
      return row;
    })();
    this.failAfterHandlerCommit();
    return {
      executionId,
      status: "timed-out",
      result: { timedOut: true },
      redelivered: false,
      executionSummary: { ...executionRow, correlationId: envelope.correlationId },
    };
  }

  private failAfterHandlerCommit(): void {
    // Ticket #58 acceptance criterion 4: a declared boundary right after
    // the handler's transaction commits and before this method acknowledges
    // the Delivery to its caller. A subsequent redelivery finds Inbox.
    if (typeof __JARVIS_TEST_HOOKS__ === "undefined" || __JARVIS_TEST_HOOKS__) {
      failpoint("after-handler-commit");
    }
  }

  private buildContext(
    delivery: ClaimedDelivery,
    envelope: EventEnvelope,
    executionId: string,
    transactionOpen: () => boolean,
    bufferedPublications: EventEnvelope[],
    failurePublications: EventEnvelope[],
    signal: AbortSignal,
    capabilities: ModuleHandlerCapabilities,
  ): ModuleHandlerContext {
    return {
      projectId: delivery.projectId,
      executionId,
      moduleInstanceId: delivery.moduleInstanceId,
      repositoryId: envelope.repositoryId,
      repositoryDefaultBranch: this.repositoryDefaultBranches(
        delivery.projectId,
        envelope.repositoryId,
      ),
      event: envelope,
      configuration: this.configurations(delivery.projectId, delivery.moduleInstanceId) ?? {},
      signal,
      capabilities,
      recordCheckpoint: (checkpoint) => {
        if (checkpoint.type === "agent.message") {
          this.checkpointStore.record({
            projectId: delivery.projectId,
            executionId,
            type: checkpoint.type,
            sourceSequence: checkpoint.sequence,
            occurredAt: checkpoint.timestamp,
            message: checkpoint.message,
          });
          return;
        }
        if (checkpoint.type === "validation.started") {
          this.checkpointStore.record({
            projectId: delivery.projectId,
            executionId,
            type: checkpoint.type,
            sourceSequence: checkpoint.sequence,
            occurredAt: checkpoint.timestamp,
            check: checkpoint.check,
          });
          return;
        }
        if (checkpoint.type === "validation.failed") {
          this.checkpointStore.record({
            projectId: delivery.projectId,
            executionId,
            type: checkpoint.type,
            sourceSequence: checkpoint.sequence,
            occurredAt: checkpoint.timestamp,
            check: checkpoint.check,
            output: checkpoint.output,
          });
          return;
        }
        if (checkpoint.type === "commit.created") {
          this.checkpointStore.record({
            projectId: delivery.projectId,
            executionId,
            type: checkpoint.type,
            sourceSequence: checkpoint.sequence,
            occurredAt: checkpoint.timestamp,
            branch: checkpoint.branch,
            sha: checkpoint.sha,
          });
          return;
        }
        if (checkpoint.type === "branch.pushed") {
          this.checkpointStore.record({
            projectId: delivery.projectId,
            executionId,
            type: checkpoint.type,
            sourceSequence: checkpoint.sequence,
            occurredAt: checkpoint.timestamp,
            branch: checkpoint.branch,
            sha: checkpoint.sha,
          });
          return;
        }
        this.checkpointStore.record({
          projectId: delivery.projectId,
          executionId,
          type: checkpoint.type,
          sourceSequence: checkpoint.sequence,
          occurredAt: checkpoint.timestamp,
        });
      },
      publish: (input) => {
        this.assertPublishedContract(delivery.moduleId, input);
        const publication = this.publisherInput(delivery, envelope, input);
        const prepared = this.previewPublication(publication, transactionOpen);
        bufferedPublications.push(prepared);
        return prepared;
      },
      publishFailure: (input) => {
        this.assertPublishedContract(delivery.moduleId, input);
        const publication = this.publisherInput(delivery, envelope, input);
        const prepared = this.previewPublication(publication, transactionOpen);
        failurePublications.push(prepared);
        return prepared;
      },
    };
  }

  private publisherInput(
    delivery: ClaimedDelivery,
    envelope: EventEnvelope,
    input: ModuleHandlerPublishInput,
  ): PublishEventInput {
    return {
      type: input.type,
      version: input.version,
      kind: input.kind,
      // A handler cannot impersonate another Module Instance.
      producer: {
        moduleId: delivery.moduleId,
        moduleInstanceId: delivery.moduleInstanceId,
      },
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
      ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
    };
  }

  private previewPublication(
    input: PublishEventInput,
    transactionOpen: () => boolean,
  ): EventEnvelope {
    if (transactionOpen()) {
      this.db.exec("SAVEPOINT jarvis_buffered_publication");
      try {
        return this.publisher.publish(input);
      } finally {
        this.db.exec("ROLLBACK TO jarvis_buffered_publication");
        this.db.exec("RELEASE jarvis_buffered_publication");
      }
    }

    let envelope: EventEnvelope | undefined;
    const rollback = Symbol("buffered publication rollback");
    try {
      this.db.transaction(() => {
        envelope = this.publisher.publish(input);
        throw rollback;
      })();
    } catch (error) {
      if (error !== rollback) throw error;
    }
    if (envelope === undefined) {
      throw new Error("Buffered publication did not produce an event envelope.");
    }
    return envelope;
  }

  private insertBufferedPublication(envelope: EventEnvelope): void {
    this.db
      .prepare(
        `INSERT INTO outbox (event_id, project_id, envelope, status, created_at)
         VALUES (@id, @projectId, @envelope, 'pending', @createdAt)`,
      )
      .run({
        id: envelope.id,
        projectId: envelope.projectId,
        envelope: JSON.stringify(envelope),
        createdAt: this.clock.now().toISOString(),
      });
  }

  private assertPublishedContract(moduleId: string, input: ModuleHandlerPublishInput): void {
    const contracts = this.publishedContracts(moduleId);
    if (
      contracts !== undefined &&
      !contracts.some(
        (contract) =>
          contract.type === input.type &&
          contract.version === input.version &&
          contract.kind === input.kind,
      )
    ) {
      throw new Error(
        `Module ${moduleId} cannot publish undeclared ${input.kind} ${input.type}.v${input.version}.`,
      );
    }
  }

  /** Returns the row just written, in the REST Ledger shape — ticket #60
   * builds the stream's `execution.changed` Live Update from this return
   * value rather than a second read of `executions`. */
  private insertExecution(
    id: string,
    delivery: ClaimedDelivery,
    envelope: EventEnvelope,
    status: "running" | "completed" | "failed" | "cancelled" | "timed_out",
    startedAt: string,
    error: string | null,
    attempt = 1,
  ): LedgerExecutionSummary {
    const completedAt = status === "running" ? null : this.clock.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO executions
           (id, project_id, module_instance_id, module_id, input_event_id, attempt, status, error, started_at, completed_at, created_at)
         VALUES
           (@id, @projectId, @moduleInstanceId, @moduleId, @inputEventId, @attempt, @status, @error, @startedAt, @completedAt, @startedAt)`,
      )
      .run({
        id,
        projectId: delivery.projectId,
        moduleInstanceId: delivery.moduleInstanceId,
        moduleId: delivery.moduleId,
        inputEventId: envelope.id,
        attempt,
        status,
        error,
        startedAt,
        completedAt,
      });
    return {
      id,
      projectId: delivery.projectId,
      moduleInstanceId: delivery.moduleInstanceId,
      status: status === "timed_out" ? "timed-out" : status,
      attempt,
      createdAt: startedAt,
      completedAt,
      inputEventId: envelope.id,
    };
  }

  private updateExecution(
    executionId: string,
    status: "completed" | "failed" | "cancelled" | "timed_out",
    error: string | null,
  ): LedgerExecutionSummary {
    const completedAt = this.clock.now().toISOString();
    const row = this.db
      .prepare(
        `UPDATE executions
         SET status = @status, error = @error, completed_at = @completedAt
         WHERE id = @id AND status IN ('running', 'cancelling')
         RETURNING id, project_id, module_instance_id, status, attempt, created_at,
                   completed_at, input_event_id`,
      )
      .get({ id: executionId, status, error, completedAt }) as ExecutionRow | undefined;
    if (row === undefined) {
      throw new Error(`Execution ${executionId} was not active when it was finalized.`);
    }
    return toExecutionSummary(row);
  }

  private insertInbox(
    delivery: ClaimedDelivery,
    status: "completed" | "failed" | "cancelled" | "timed_out",
    result: unknown,
    attempt = 1,
  ): void {
    this.db
      .prepare(
        `INSERT INTO inbox (project_id, module_instance_id, event_id, status, attempt, result, created_at)
         VALUES (@projectId, @moduleInstanceId, @eventId, @status, @attempt, @result, @createdAt)`,
      )
      .run({
        projectId: delivery.projectId,
        moduleInstanceId: delivery.moduleInstanceId,
        eventId: delivery.eventId,
        attempt,
        status,
        result: JSON.stringify(result ?? null),
        createdAt: this.clock.now().toISOString(),
      });
  }

  private markDeliveryConsumed(delivery: ClaimedDelivery, attempt = 1): void {
    this.db
      .prepare(
        `UPDATE deliveries SET consumed_at = @now, attempt_count = @attempt, next_attempt_at = NULL
         WHERE project_id = @projectId AND module_instance_id = @moduleInstanceId AND event_id = @eventId`,
      )
      .run({
        projectId: delivery.projectId,
        moduleInstanceId: delivery.moduleInstanceId,
        eventId: delivery.eventId,
        attempt,
        now: this.clock.now().toISOString(),
      });
  }

  private readDeliveryAttempt(delivery: ClaimedDelivery): number {
    const row = this.db
      .prepare(
        `SELECT attempt_count FROM deliveries
         WHERE project_id = @projectId AND module_instance_id = @moduleInstanceId AND event_id = @eventId`,
      )
      .get(delivery) as { attempt_count: number } | undefined;
    if (row === undefined) {
      throw new Error(
        `No Delivery exists for Project ${delivery.projectId}, module instance ${delivery.moduleInstanceId}, event ${delivery.eventId}.`,
      );
    }
    return row.attempt_count + 1;
  }

  private scheduleRetry(delivery: ClaimedDelivery, attempt: number, nextAttemptAt: string): void {
    this.db
      .prepare(
        `UPDATE deliveries
         SET attempt_count = @attempt, next_attempt_at = @nextAttemptAt
         WHERE project_id = @projectId AND module_instance_id = @moduleInstanceId AND event_id = @eventId
           AND consumed_at IS NULL`,
      )
      .run({
        projectId: delivery.projectId,
        moduleInstanceId: delivery.moduleInstanceId,
        eventId: delivery.eventId,
        attempt,
        nextAttemptAt,
      });
  }

  private readDeadLetter(
    delivery: ClaimedDelivery,
  ): { readonly code: string; readonly message: string } | undefined {
    return this.db
      .prepare(
        `SELECT dead_letters.code, dead_letters.message
         FROM dead_letters
         INNER JOIN deliveries ON deliveries.id = dead_letters.delivery_id
         WHERE deliveries.project_id = @projectId
           AND deliveries.module_instance_id = @moduleInstanceId
           AND deliveries.event_id = @eventId`,
      )
      .get(delivery) as { code: string; message: string } | undefined;
  }

  private insertDeadLetter(
    delivery: ClaimedDelivery,
    code: string,
    message: string,
    attempts: number,
    lastExecutionId: string,
  ): void {
    const row = this.db
      .prepare(
        `SELECT id FROM deliveries
         WHERE project_id = @projectId AND module_instance_id = @moduleInstanceId AND event_id = @eventId`,
      )
      .get(delivery) as { id: string } | undefined;
    if (row === undefined) {
      throw new Error(
        `No Delivery exists for Project ${delivery.projectId}, module instance ${delivery.moduleInstanceId}, event ${delivery.eventId}.`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO dead_letters
           (delivery_id, project_id, event_id, module_instance_id, code, message, attempts, last_execution_id, created_at)
         VALUES
           (@deliveryId, @projectId, @eventId, @moduleInstanceId, @code, @message, @attempts, @lastExecutionId, @createdAt)
         ON CONFLICT (delivery_id) DO NOTHING`,
      )
      .run({
        deliveryId: row.id,
        projectId: delivery.projectId,
        eventId: delivery.eventId,
        moduleInstanceId: delivery.moduleInstanceId,
        code,
        message,
        attempts,
        lastExecutionId,
        createdAt: this.clock.now().toISOString(),
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

function readStructuredFailure(
  error: unknown,
): { readonly code: string; readonly retryable: boolean } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { readonly code?: unknown; readonly retryable?: unknown };
  return typeof candidate.code === "string" && typeof candidate.retryable === "boolean"
    ? { code: candidate.code, retryable: candidate.retryable }
    : undefined;
}

function readFailureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function inferredRetryability(code: string | undefined, message: string): boolean {
  const value = `${code ?? ""} ${message}`;
  if (
    /(?:validation|invalid|permission|forbidden|unauthori[sz]ed|access[- ]denied|not[- ]allowed|not[- ]found|missing|conflict|already[- ](?:exists|imported)|cancelled|canceled)/i.test(
      value,
    )
  ) {
    return false;
  }
  // Unknown failures stay retryable; a bounded retry budget is safer than
  // permanently dropping an unclassified transient outage.
  return true;
}

function cleanHandlerFailureMessage(message: string): string {
  return message
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/((?:authorization|proxy-authorization)\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1<redacted>")
    .replace(
      /((?:token|secret|password|passwd|authorization|credential|api[_-]?key|access[_-]?(?:key|token)|private[_-]?key|cookie|session)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1<redacted>",
    )
    .replace(
      /\b(?:gh[opsru]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]+)\b/g,
      "<redacted>",
    )
    .replace(/(^|[\s("'`=:])\/(?!\/)[^\s"'`<>]+/g, "$1<path>")
    .replace(/(^|[\s("'`=:])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+/g, "$1<path>");
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return false;
  }
  return typeof (value as { then?: unknown }).then === "function";
}

function isTimedOutResult(value: unknown): value is { readonly status: "timed-out" } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { status?: unknown }).status === "timed-out"
  );
}

function isCancelledResult(value: unknown): value is { readonly status: "cancelled" } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { status?: unknown }).status === "cancelled"
  );
}

function inboxStatusToApi(
  status: InboxRow["status"],
): "completed" | "failed" | "cancelled" | "timed-out" {
  return status === "timed_out" ? "timed-out" : status;
}

function readExecutionSummary(
  db: Database.Database,
  executionId: string,
): LedgerExecutionSummary | undefined {
  const row = db
    .prepare(
      `SELECT id, project_id, module_instance_id, status, attempt, created_at, completed_at,
              input_event_id
       FROM executions WHERE id = @executionId`,
    )
    .get({ executionId }) as ExecutionRow | undefined;
  if (row === undefined) return undefined;
  return toExecutionSummary(row);
}

function toExecutionSummary(row: ExecutionRow): LedgerExecutionSummary {
  const status = STATUS_TO_API[row.status];
  if (status === undefined) {
    throw new Error(`Execution ${row.id} has an unrecognized Ledger status "${row.status}".`);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    moduleInstanceId: row.module_instance_id,
    status,
    attempt: row.attempt,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    inputEventId: row.input_event_id,
  };
}
