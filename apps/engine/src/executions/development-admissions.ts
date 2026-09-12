import type Database from "better-sqlite3";
import type { Clock } from "../../../../packages/kernel/src/clock.js";

export interface DevelopmentAdmission {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly workItemRef: string | undefined;
  readonly repositoryId: string | undefined;
  readonly status: "waiting-capacity" | "blocked" | "impossible" | "ineligible" | "suspended";
  readonly reason: string;
}

export class DevelopmentAdmissions {
  public constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
  ) {}

  public read(projectId: string): {
    readonly suspended: boolean;
    readonly items: readonly DevelopmentAdmission[];
  } {
    const suspended = this.db
      .prepare("SELECT suspended_at FROM development_admission_controls WHERE project_id = ?")
      .get(projectId) as { suspended_at: string | null } | undefined;
    const rows = this.db
      .prepare(
        `SELECT deliveries.id, deliveries.event_id, events.envelope, admissions.status, admissions.reason
         FROM deliveries
         JOIN events ON events.id = deliveries.event_id
         LEFT JOIN development_admissions admissions ON admissions.delivery_id = deliveries.id
         WHERE deliveries.project_id = ? AND deliveries.module_id = 'jarvis.module.development'
           AND deliveries.consumed_at IS NULL
         ORDER BY deliveries.created_at, deliveries.id`,
      )
      .all(projectId) as {
      readonly id: string;
      readonly event_id: string;
      readonly envelope: string;
      readonly status: DevelopmentAdmission["status"] | null;
      readonly reason: string | null;
    }[];
    return {
      suspended: suspended?.suspended_at !== null && suspended !== undefined,
      items: rows.map((row) => ({
        deliveryId: row.id,
        eventId: row.event_id,
        ...references(row.envelope),
        status:
          suspended?.suspended_at !== null && suspended !== undefined
            ? "suspended"
            : (row.status ?? "waiting-capacity"),
        reason:
          suspended?.suspended_at !== null && suspended !== undefined
            ? "admission-suspended"
            : (row.reason ?? "awaiting-capacity"),
      })),
    };
  }

  public suspend(projectId: string): void {
    const now = this.clock.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO development_admission_controls (project_id, suspended_at, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET suspended_at = excluded.suspended_at,
           updated_at = excluded.updated_at`,
      )
      .run(projectId, now, now);
  }

  public resume(projectId: string): void {
    const now = this.clock.now().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO development_admission_controls (project_id, suspended_at, updated_at)
           VALUES (?, NULL, ?)
           ON CONFLICT (project_id) DO UPDATE SET suspended_at = NULL, updated_at = excluded.updated_at`,
        )
        .run(projectId, now);
      this.db
        .prepare(
          `UPDATE deliveries SET next_attempt_at = ?
           WHERE project_id = ? AND module_id = 'jarvis.module.development' AND consumed_at IS NULL`,
        )
        .run(now, projectId);
    })();
  }
}

function references(envelope: string): {
  readonly workItemRef: string | undefined;
  readonly repositoryId: string | undefined;
} {
  try {
    const payload = (JSON.parse(envelope) as { payload?: Record<string, unknown> }).payload;
    return {
      workItemRef:
        typeof payload?.["workItemRef"] === "string" ? payload["workItemRef"] : undefined,
      repositoryId:
        typeof payload?.["repositoryId"] === "string" ? payload["repositoryId"] : undefined,
    };
  } catch {
    return { workItemRef: undefined, repositoryId: undefined };
  }
}
