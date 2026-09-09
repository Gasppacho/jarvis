import type Database from "better-sqlite3";

export type ExecutionCheckpointInput =
  | {
      readonly projectId: string;
      readonly executionId: string;
      readonly type: "agent.started";
      readonly sourceSequence: number;
      readonly occurredAt: string;
    }
  | {
      readonly projectId: string;
      readonly executionId: string;
      readonly type: "agent.message";
      readonly sourceSequence: number;
      readonly occurredAt: string;
      readonly message: string;
    }
  | {
      readonly projectId: string;
      readonly executionId: string;
      readonly type: "validation.started";
      readonly sourceSequence: number;
      readonly occurredAt: string;
      readonly check: string;
    }
  | {
      readonly projectId: string;
      readonly executionId: string;
      readonly type: "validation.failed";
      readonly sourceSequence: number;
      readonly occurredAt: string;
      readonly check: string;
      readonly output: string;
    }
  | {
      readonly projectId: string;
      readonly executionId: string;
      readonly type: "commit.created";
      readonly sourceSequence: number;
      readonly occurredAt: string;
      readonly branch: string;
      readonly sha: string;
    };

export interface ExecutionCheckpoint {
  readonly projectId: string;
  readonly executionId: string;
  readonly sequence: number;
  readonly sourceSequence: number;
  readonly type: ExecutionCheckpointInput["type"];
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

interface ExecutionCheckpointRow {
  readonly project_id: string;
  readonly execution_id: string;
  readonly sequence: number;
  readonly source_sequence: number;
  readonly type: ExecutionCheckpointInput["type"];
  readonly payload: string;
  readonly occurred_at: string;
}

/** Durable, project-scoped progress owned by the Execution Ledger. */
export class ExecutionCheckpointStore {
  public constructor(private readonly db: Database.Database) {}

  public record(input: ExecutionCheckpointInput): ExecutionCheckpoint {
    validateInput(input);
    return this.db.transaction(() => {
      const execution = this.db
        .prepare(
          "SELECT 1 AS present FROM executions WHERE id = @executionId AND project_id = @projectId",
        )
        .get(input) as { present: number } | undefined;
      if (execution === undefined) {
        throw new Error(
          `Execution ${input.executionId} does not belong to Project ${input.projectId}.`,
        );
      }

      const bySourceSequence = this.db
        .prepare(
          `SELECT project_id, execution_id, sequence, source_sequence, type, payload, occurred_at
           FROM execution_checkpoints
           WHERE project_id = @projectId AND execution_id = @executionId
             AND source_sequence = @sourceSequence`,
        )
        .get(input) as ExecutionCheckpointRow | undefined;
      if (bySourceSequence !== undefined) return toCheckpoint(bySourceSequence);

      if (input.type === "agent.started") {
        const started = this.db
          .prepare(
            `SELECT project_id, execution_id, sequence, source_sequence, type, payload, occurred_at
             FROM execution_checkpoints
             WHERE project_id = @projectId AND execution_id = @executionId
               AND type = 'agent.started'`,
          )
          .get(input) as ExecutionCheckpointRow | undefined;
        if (started !== undefined) return toCheckpoint(started);
      }

      const nextSequence = this.db
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
           FROM execution_checkpoints
           WHERE project_id = @projectId AND execution_id = @executionId`,
        )
        .get(input) as { sequence: number };
      const payload = checkpointPayload(input);
      this.db
        .prepare(
          `INSERT INTO execution_checkpoints
             (project_id, execution_id, sequence, source_sequence, type, payload, occurred_at)
           VALUES
             (@projectId, @executionId, @sequence, @sourceSequence, @type, @payload, @occurredAt)`,
        )
        .run({
          projectId: input.projectId,
          executionId: input.executionId,
          sequence: nextSequence.sequence,
          sourceSequence: input.sourceSequence,
          type: input.type,
          payload: JSON.stringify(payload),
          occurredAt: input.occurredAt,
        });
      return {
        projectId: input.projectId,
        executionId: input.executionId,
        sequence: nextSequence.sequence,
        sourceSequence: input.sourceSequence,
        type: input.type,
        payload,
        occurredAt: input.occurredAt,
      };
    })();
  }

  public list(projectId: string, executionId: string): ExecutionCheckpoint[] {
    const rows = this.db
      .prepare(
        `SELECT project_id, execution_id, sequence, source_sequence, type, payload, occurred_at
         FROM execution_checkpoints
         WHERE project_id = @projectId AND execution_id = @executionId
         ORDER BY sequence ASC`,
      )
      .all({ projectId, executionId }) as ExecutionCheckpointRow[];
    return rows.map(toCheckpoint);
  }
}

function validateInput(input: ExecutionCheckpointInput): void {
  if (
    !Number.isSafeInteger(input.sourceSequence) ||
    input.sourceSequence < 1 ||
    input.projectId === "" ||
    input.executionId === "" ||
    input.occurredAt === ""
  ) {
    throw new Error("Execution checkpoint identity and sequence are invalid.");
  }
  if (
    (input.type === "agent.message" && typeof input.message !== "string") ||
    ((input.type === "validation.started" || input.type === "validation.failed") &&
      (typeof input.check !== "string" || input.check === "")) ||
    (input.type === "validation.failed" && typeof input.output !== "string") ||
    (input.type === "commit.created" &&
      (typeof input.branch !== "string" ||
        input.branch === "" ||
        typeof input.sha !== "string" ||
        input.sha === ""))
  ) {
    throw new Error("Execution checkpoint content is invalid.");
  }
}

function checkpointPayload(input: ExecutionCheckpointInput): Readonly<Record<string, unknown>> {
  if (input.type === "agent.started") return {};
  if (input.type === "agent.message") {
    return { message: sanitizeCheckpointMessage(input.message) };
  }
  if (input.type === "validation.started") {
    return { check: sanitizeCheckpointMessage(input.check) };
  }
  if (input.type === "validation.failed") {
    return {
      check: sanitizeCheckpointMessage(input.check),
      output: sanitizeCheckpointMessage(input.output),
    };
  }
  return {
    branch: sanitizeCheckpointMessage(input.branch),
    sha: input.sha,
  };
}

function sanitizeCheckpointMessage(message: string): string {
  return message
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(
      /((?:token|secret|password|passwd|authorization|credential|api[_-]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1<redacted>",
    )
    .replace(/(?:\/Users|\/home|\/private\/var)\/[^\s"'`<>]+/g, "<path>");
}

function toCheckpoint(row: ExecutionCheckpointRow): ExecutionCheckpoint {
  const payload: unknown = JSON.parse(row.payload);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`Execution checkpoint ${row.sequence} has an invalid payload.`);
  }
  return {
    projectId: row.project_id,
    executionId: row.execution_id,
    sequence: row.sequence,
    sourceSequence: row.source_sequence,
    type: row.type,
    payload: payload as Readonly<Record<string, unknown>>,
    occurredAt: row.occurred_at,
  };
}
