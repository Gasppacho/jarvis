import type Database from "better-sqlite3";
import type { Clock } from "../../../../packages/kernel/src/clock.js";

export type GitHubPollingState = "live" | "reconnecting" | "failed";

export interface GitHubPollingStatus {
  readonly moduleInstanceId: string;
  readonly repositoryId: string;
  readonly state: GitHubPollingState;
  readonly lastPollAt: string | null;
  readonly errorReason: string | null;
}

/** Durable, secret-free health of each Project-bound GitHub poll target. */
export class GitHubPollingStatusStore {
  public constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
  ) {}

  public read(projectId: string): readonly GitHubPollingStatus[] {
    const rows = this.db
      .prepare(
        `SELECT module_instance_id, repository_id, state, last_poll_at, error_reason
         FROM github_polling_status
         WHERE project_id = ?
         ORDER BY repository_id, module_instance_id`,
      )
      .all(projectId) as PollingStatusRow[];
    return rows.map((row) => ({
      moduleInstanceId: row.module_instance_id,
      repositoryId: row.repository_id,
      state: row.state,
      lastPollAt: row.last_poll_at,
      errorReason: row.error_reason,
    }));
  }

  public reconnecting(projectId: string, moduleInstanceId: string, repositoryId: string): void {
    this.write(projectId, moduleInstanceId, repositoryId, "reconnecting", null);
  }

  public succeeded(projectId: string, moduleInstanceId: string, repositoryId: string): void {
    this.write(projectId, moduleInstanceId, repositoryId, "live", this.clock.now().toISOString());
  }

  public failed(
    projectId: string,
    moduleInstanceId: string,
    repositoryId: string,
    reason: string,
  ): void {
    this.write(projectId, moduleInstanceId, repositoryId, "failed", null, reason);
  }

  public failModule(projectId: string, moduleInstanceId: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE github_polling_status
         SET state = 'failed', error_reason = ?, updated_at = ?
         WHERE project_id = ? AND module_instance_id = ?`,
      )
      .run(reason, this.clock.now().toISOString(), projectId, moduleInstanceId);
  }

  private write(
    projectId: string,
    moduleInstanceId: string,
    repositoryId: string,
    state: GitHubPollingState,
    lastPollAt: string | null,
    errorReason: string | null = null,
  ): void {
    const now = this.clock.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO github_polling_status
           (project_id, module_instance_id, repository_id, state, last_poll_at, error_reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, module_instance_id, repository_id) DO UPDATE SET
           state = excluded.state,
           last_poll_at = COALESCE(excluded.last_poll_at, github_polling_status.last_poll_at),
           error_reason = excluded.error_reason,
           updated_at = excluded.updated_at`,
      )
      .run(projectId, moduleInstanceId, repositoryId, state, lastPollAt, errorReason, now);
  }
}

interface PollingStatusRow {
  readonly module_instance_id: string;
  readonly repository_id: string;
  readonly state: GitHubPollingState;
  readonly last_poll_at: string | null;
  readonly error_reason: string | null;
}
