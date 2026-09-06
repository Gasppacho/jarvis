import type Database from "better-sqlite3";
import type { Clock } from "../../../../packages/kernel/src/clock.js";
import type { IdGenerator } from "../../../../packages/kernel/src/id-generator.js";
import {
  EventEnvelopeContractRegistry,
  InvalidEventEnvelopeError,
  type EventEnvelope,
} from "../../../../packages/eventing/src/envelope.js";
import { EngineError } from "../errors.js";

export interface PublishEventInput {
  readonly type: string;
  readonly version: number;
  readonly kind: "request" | "fact";
  readonly projectId: string;
  readonly repositoryId?: string;
  readonly producer: { readonly moduleId: string; readonly moduleInstanceId: string };
  readonly subject: { readonly type: string; readonly ref: string };
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly target?: { readonly binding?: string; readonly moduleInstanceId?: string };
  readonly idempotencyKey?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Ticket #56 (docs/architecture/EVENTS.md "Event transaction rule"): a plain
 * method with no transaction of its own, so it always runs inside whichever
 * `db.transaction()` the caller already opened — in production, a Module's
 * own state mutation. `id`/`occurredAt` come from the injected ports, never
 * from the caller, so tests are deterministic without freezing production
 * wall-clock behaviour.
 *
 * An invalid envelope throws before any statement runs, so the ambient
 * transaction rolls back the caller's state mutation too — "nothing is
 * written" (issue #56 acceptance criteria) covers both.
 */
export class EventPublisher {
  public constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly envelopes: EventEnvelopeContractRegistry,
  ) {}

  public publish(input: PublishEventInput): EventEnvelope {
    // `input` is spread first so a caller can never supply its own `id` or
    // `occurredAt`: both come from the injected ports, always.
    const candidate: unknown = {
      ...input,
      specVersion: "1.0",
      id: `evt_${this.ids.next()}`,
      occurredAt: this.clock.now().toISOString(),
    };

    const envelope = this.requireEnvelope(candidate);

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

    return envelope;
  }

  private requireEnvelope(candidate: unknown): EventEnvelope {
    try {
      return this.envelopes.requireEnvelope(candidate);
    } catch (error) {
      if (error instanceof InvalidEventEnvelopeError) {
        throw new EngineError("event.envelope-invalid", 400, error.message, {
          issues: [...error.issues],
        });
      }
      throw error;
    }
  }
}
