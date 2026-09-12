import type Database from "better-sqlite3";
import type { ModuleValidationSnapshot } from "../../../../packages/module-sdk/src/index.js";

export type ExecutionCheckpointInput =
  | {
      readonly projectId: string;
      readonly executionId: string;
      readonly type: "preparation.started" | "preparation.completed";
      readonly sourceSequence: number;
      readonly occurredAt: string;
    }
  | {
      readonly projectId: string;
      readonly executionId: string;
      readonly type: "preparation.failed";
      readonly sourceSequence: number;
      readonly occurredAt: string;
      readonly output: string;
    }
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
      readonly validation?: ModuleValidationSnapshot;
      readonly title?: string;
    }
  | {
      readonly projectId: string;
      readonly executionId: string;
      readonly type: "branch.pushed";
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

  public list(projectId: string, executionId: string, limit?: number): ExecutionCheckpoint[] {
    const sqlLimit = limit === undefined ? "" : " LIMIT @limit";
    const rows = this.db
      .prepare(
        `SELECT project_id, execution_id, sequence, source_sequence, type, payload, occurred_at
         FROM execution_checkpoints
         WHERE project_id = @projectId AND execution_id = @executionId
         ORDER BY sequence ${limit === undefined ? "ASC" : "DESC"}${sqlLimit}`,
      )
      .all(
        limit === undefined
          ? { projectId, executionId }
          : { projectId, executionId, limit: Math.max(1, Math.floor(limit)) },
      ) as ExecutionCheckpointRow[];
    const checkpoints = rows.map(toCheckpoint);
    return limit === undefined ? checkpoints : checkpoints.reverse();
  }

  public has(
    projectId: string,
    executionId: string,
    type: ExecutionCheckpointInput["type"],
  ): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 AS present FROM execution_checkpoints
           WHERE project_id = @projectId AND execution_id = @executionId AND type = @type`,
        )
        .get({ projectId, executionId, type }) !== undefined
    );
  }

  public lastSourceSequence(projectId: string, executionId: string): number {
    return (
      this.db
        .prepare(
          `SELECT COALESCE(MAX(source_sequence), 0) AS sequence FROM execution_checkpoints
           WHERE project_id = @projectId AND execution_id = @executionId`,
        )
        .get({ projectId, executionId }) as { sequence: number }
    ).sequence;
  }

  public readForInput(
    projectId: string,
    moduleInstanceId: string,
    eventId: string,
    type: ExecutionCheckpointInput["type"],
  ): ExecutionCheckpoint | undefined {
    const row = this.db
      .prepare(
        `SELECT checkpoint.* FROM execution_checkpoints checkpoint
       JOIN executions execution ON execution.id = checkpoint.execution_id
         AND execution.project_id = checkpoint.project_id
       WHERE execution.project_id = ? AND execution.module_instance_id = ?
         AND execution.input_event_id = ? AND checkpoint.type = ?
       ORDER BY execution.attempt DESC, checkpoint.sequence DESC LIMIT 1`,
      )
      .get(projectId, moduleInstanceId, eventId, type) as ExecutionCheckpointRow | undefined;
    return row === undefined ? undefined : toCheckpoint(row);
  }
}

function validateInput(input: ExecutionCheckpointInput): void {
  if (input.type === "commit.created" && input.validation !== undefined) {
    const snapshot = input.validation;
    if (
      !/^[a-f0-9]{64}$/.test(snapshot.planHash) ||
      !Array.isArray(snapshot.commands) ||
      snapshot.commands.length > 100 ||
      !snapshot.commands.every(
        (check) =>
          typeof check.name === "string" &&
          /^[a-z][a-z0-9.-]{0,99}$/.test(check.name) &&
          check.status === "passed" &&
          Number.isFinite(check.durationMs) &&
          check.durationMs >= 0,
      )
    ) {
      throw new Error("Execution validation snapshot is invalid.");
    }
  }
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
    (input.type === "preparation.failed" && typeof input.output !== "string") ||
    ((input.type === "validation.started" || input.type === "validation.failed") &&
      (typeof input.check !== "string" || input.check === "")) ||
    (input.type === "validation.failed" && typeof input.output !== "string") ||
    ((input.type === "commit.created" || input.type === "branch.pushed") &&
      (typeof input.branch !== "string" ||
        input.branch === "" ||
        typeof input.sha !== "string" ||
        input.sha === ""))
  ) {
    throw new Error("Execution checkpoint content is invalid.");
  }
}

function checkpointPayload(input: ExecutionCheckpointInput): Readonly<Record<string, unknown>> {
  if (
    input.type === "agent.started" ||
    input.type === "preparation.started" ||
    input.type === "preparation.completed"
  ) {
    return {};
  }
  if (input.type === "preparation.failed") {
    return { output: sanitizeCheckpointMessage(input.output) };
  }
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
  if (input.type === "commit.created" || input.type === "branch.pushed") {
    return {
      branch: sanitizeCheckpointMessage(input.branch),
      sha: input.sha,
      ...(input.type === "commit.created" && input.validation !== undefined
        ? {
            validation: {
              planHash: input.validation.planHash,
              commands: input.validation.commands.map(({ name, status, durationMs }) => ({
                name,
                status,
                durationMs,
              })),
            },
          }
        : {}),
      ...(input.type === "commit.created" && input.title !== undefined
        ? { title: sanitizeCheckpointMessage(input.title).slice(0, 256) }
        : {}),
    };
  }
  return {};
}

function sanitizeCheckpointMessage(message: string): string {
  return message
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(
      /((?:["']?)(?:token|secret|password|passwd|authorization|credential|api[_-]?key)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;{}]+)/gi,
      "$1<redacted>",
    )
    .replace(
      /\b(?:gh[opsru]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g,
      "<redacted>",
    )
    .replace(/\bfile:\/\/[^\s"'<>;,)\]}]+/gi, "<path>")
    .replace(/(^|[\s("'`=:])\/(?!\/)[^\s"'`<>]+/g, "$1<path>");
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
