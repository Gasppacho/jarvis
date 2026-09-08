import type Database from "better-sqlite3";

/** The contract's spelling (contracts/openapi/local-api.v1.yaml
 * `ExecutionSummary.status`). Differs from the Ledger's own stored spelling
 * for exactly one state — see `STATUS_TO_API` below. */
export type ExecutionApiStatus =
  "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "timed-out";

export interface ListExecutionsQuery {
  readonly limit: number;
}

export interface LedgerExecutionSummary {
  readonly id: string;
  readonly projectId: string;
  readonly moduleInstanceId: string;
  readonly status: ExecutionApiStatus;
  readonly attempt: number;
  readonly createdAt: string;
  readonly completedAt: string | null;
  /** The input Event's id (0007_inbox_execution_ledger.sql `input_event_id`),
   * so a client can attach this Execution to the Event that caused it (issue
   * #59). The Ledger owns this column directly: no cross-context read is
   * needed to produce it. */
  readonly inputEventId: string;
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

/** 0007_inbox_execution_ledger.sql's CHECK spells this state `timed_out`;
 * the OpenAPI contract spells it `timed-out`. Every other state is spelled
 * identically in both places. The DeliveryConsumer writes cancellation and
 * timeout states when the runtime/module result is terminal. */
export const STATUS_TO_API: Record<string, ExecutionApiStatus> = {
  queued: "queued",
  running: "running",
  cancelling: "cancelling",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  timed_out: "timed-out",
};

/**
 * The Execution Ledger's read model over the `executions` table
 * (docs/architecture/PERSISTENCE.md "Logical ownership": the Execution
 * Ledger owns `executions`; issue #59 "Reading the journal ... must respect
 * table ownership"). Never reads `events` itself — a caller that needs an
 * Execution's correlation asks `EventJournalReader.correlationIdsByEventId`
 * (../events/timeline.ts) with the `inputEventId` this class already
 * returns.
 */
export class ExecutionLedgerReader {
  public constructor(private readonly db: Database.Database) {}

  /** Newest first, tie-broken by `id DESC` for the same reason the Event
   * journal reader is (docs/contracts/LOCAL_API_V1.md "Events and
   * executions"). `limit` bounds this the same way `EventJournalReader.list`
   * is bounded (issue #59 code review, finding 1): `better-sqlite3`'s `.all()`
   * is synchronous, so an unbounded read of a large Ledger would block the
   * engine's single thread for the duration of the query. */
  public list(projectId: string, query: ListExecutionsQuery): LedgerExecutionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, module_instance_id, status, attempt, created_at, completed_at, input_event_id
         FROM executions
         WHERE project_id = @projectId
         ORDER BY created_at DESC, id DESC
         LIMIT @limit`,
      )
      .all({ projectId, limit: query.limit }) as ExecutionRow[];
    return rows.map(toSummary);
  }
}

function toSummary(row: ExecutionRow): LedgerExecutionSummary {
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
