import type Database from "better-sqlite3";
import type { Clock } from "../../../../packages/kernel/src/clock.js";
import type {
  PollCursorCapability,
  PollCursorRecord,
} from "../../../../packages/module-sdk/src/index.js";

interface PollCursorRow {
  readonly external_event_id: string;
  readonly event_timestamp: string;
  readonly updated_at: string;
}

/** Durable project/module/repository-scoped positions for the GitHub observer. */
export class PollCursorStore {
  public constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
  ) {}

  public bind(projectId: string, moduleInstanceId: string): PollCursorCapability {
    return {
      read: (repositoryId) => {
        const row = this.db
          .prepare(
            `SELECT external_event_id, event_timestamp, updated_at
             FROM github_cursors
             WHERE project_id = @projectId
               AND module_instance_id = @moduleInstanceId
               AND repository_id = @repositoryId`,
          )
          .get({ projectId, moduleInstanceId, repositoryId }) as PollCursorRow | undefined;
        if (row === undefined) return undefined;
        return toRecord(row);
      },
      write: ({ repositoryId, externalEventId, eventTimestamp }) => {
        this.db
          .prepare(
            `INSERT INTO github_cursors
               (project_id, module_instance_id, repository_id, external_event_id, event_timestamp, updated_at)
             VALUES (@projectId, @moduleInstanceId, @repositoryId, @externalEventId, @eventTimestamp, @updatedAt)
             ON CONFLICT (project_id, module_instance_id, repository_id) DO UPDATE SET
               external_event_id = excluded.external_event_id,
               event_timestamp = excluded.event_timestamp,
               updated_at = excluded.updated_at`,
          )
          .run({
            projectId,
            moduleInstanceId,
            repositoryId,
            externalEventId,
            eventTimestamp,
            updatedAt: this.clock.now().toISOString(),
          });
      },
    };
  }
}

function toRecord(row: PollCursorRow): PollCursorRecord {
  return {
    externalEventId: row.external_event_id,
    eventTimestamp: row.event_timestamp,
    updatedAt: row.updated_at,
  };
}
