import type Database from "better-sqlite3";
import type { EventEnvelope } from "../../../../packages/eventing/src/envelope.js";

export interface EventSummary {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly kind: "request" | "fact";
  readonly occurredAt: string;
  /** The producing Module Instance id (`envelope.producer.moduleInstanceId`),
   * not the Module id: "which module instance produced this" is the question
   * a client asks the timeline (issue #59 decision). */
  readonly producer: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly subjectRef: string;
}

export interface ListEventsQuery {
  readonly correlationId?: string;
  readonly limit: number;
}

interface EventRow {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly kind: "request" | "fact";
  readonly occurred_at: string;
  readonly envelope: string;
  readonly correlation_id: string;
}

/**
 * Eventing's read model over the durable `events` journal
 * (docs/architecture/PERSISTENCE.md "Logical ownership": Eventing owns
 * `events`; issue #59 "Reading the journal ... must respect table
 * ownership"). No other context prepares a statement against this table —
 * the Execution Ledger's read model (../executions/ledger.ts) asks this
 * class for a correlationId instead of reading `events` itself.
 */
export class EventJournalReader {
  public constructor(private readonly db: Database.Database) {}

  /**
   * Newest first (docs/contracts/LOCAL_API_V1.md "Events and executions"):
   * `occurred_at DESC`, tie-broken by `id DESC` so two Events sharing an
   * occurrence timestamp never swap order between calls. `limit` truncates
   * the oldest end of that order. An unknown `correlationId` matches no row
   * and returns an empty list rather than an error.
   *
   * Two prepared statements, not one `(@correlationId IS NULL OR
   * correlation_id = @correlationId)`: `EXPLAIN QUERY PLAN` against this
   * schema (issue #59 code review, finding 5) shows that wrapper defeats the
   * planner even with `events_project_id_correlation_id_occurred_at`
   * (0008_events_correlation_id.sql) in place — it falls back to
   * `events_project_id_occurred_at` plus a temp b-tree for the ORDER BY. A
   * plain `correlation_id = ?` in its own statement is what the covering
   * index is actually chosen for.
   */
  public list(projectId: string, query: ListEventsQuery): EventSummary[] {
    const rows = (
      query.correlationId === undefined
        ? this.db
            .prepare(
              `SELECT id, type, version, kind, occurred_at, envelope, correlation_id FROM events
               WHERE project_id = @projectId
               ORDER BY occurred_at DESC, id DESC
               LIMIT @limit`,
            )
            .all({ projectId, limit: query.limit })
        : this.db
            .prepare(
              `SELECT id, type, version, kind, occurred_at, envelope, correlation_id FROM events
               WHERE project_id = @projectId AND correlation_id = @correlationId
               ORDER BY occurred_at DESC, id DESC
               LIMIT @limit`,
            )
            .all({ projectId, correlationId: query.correlationId, limit: query.limit })
    ) as EventRow[];
    return rows.map(toSummary);
  }

  /**
   * Batch lookup the Execution Ledger's read model uses to attach each
   * Execution's input Event correlation (`ExecutionSummary.correlationId`)
   * without reading `events` itself — the composition happens here, in
   * Eventing's own reader, not in the Ledger's.
   */
  public correlationIdsByEventId(
    projectId: string,
    eventIds: readonly string[],
  ): ReadonlyMap<string, string> {
    if (eventIds.length === 0) return new Map();
    const rows = this.db
      .prepare(
        `SELECT id, correlation_id AS correlationId FROM events
         WHERE project_id = @projectId
           AND id IN (SELECT value FROM json_each(@eventIds))`,
      )
      .all({ projectId, eventIds: JSON.stringify(eventIds) }) as {
      readonly id: string;
      readonly correlationId: string;
    }[];
    return new Map(rows.map((row) => [row.id, row.correlationId]));
  }
}

function toSummary(row: EventRow): EventSummary {
  const envelope = JSON.parse(row.envelope) as EventEnvelope;
  return {
    id: row.id,
    type: row.type,
    version: row.version,
    kind: row.kind,
    occurredAt: row.occurred_at,
    producer: envelope.producer.moduleInstanceId,
    // Issue #59 code review, finding 3: read from the same `correlation_id`
    // column `list()` filters on, not `envelope.correlationId` — a second
    // source that nothing kept in sync with the first. The column is also
    // `NOT NULL` (0008_events_correlation_id.sql), so this can never surface
    // as a `null` on the wire (finding 2) the way a nullable column read here
    // could have.
    correlationId: row.correlation_id,
    causationId: envelope.causationId,
    subjectRef: envelope.subject.ref,
  };
}
