import type Database from "better-sqlite3";
import type { components } from "../api/generated/local-api.js";

export type DeadLetterSummary = components["schemas"]["DeadLetter"];

export interface DeadLetterReader {
  list(projectId: string): DeadLetterSummary[];
}

/** Eventing owns the dead_letters table and exposes its project-scoped read model. */
export class EventingDeadLetterReader implements DeadLetterReader {
  public constructor(private readonly db: Database.Database) {}

  public list(projectId: string): DeadLetterSummary[] {
    return this.db
      .prepare(
        `SELECT delivery_id AS deliveryId, project_id AS projectId, event_id AS eventId,
                module_instance_id AS moduleInstanceId, code, message, attempts,
                last_execution_id AS lastExecutionId, created_at AS createdAt
         FROM dead_letters
         WHERE project_id = @projectId
         ORDER BY created_at DESC, delivery_id DESC`,
      )
      .all({ projectId }) as DeadLetterSummary[];
  }
}
