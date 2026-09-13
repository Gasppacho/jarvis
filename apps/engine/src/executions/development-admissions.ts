import type Database from "better-sqlite3";
import type { Clock } from "../../../../packages/kernel/src/clock.js";
import type { DevelopmentAdmissionCapability } from "../../../../packages/module-sdk/src/index.js";

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
           AND events.type = 'development.implementation.requested'
           AND (deliveries.consumed_at IS NULL OR admissions.status = 'ineligible')
           AND NOT EXISTS (
             SELECT 1 FROM executions execution JOIN workspace_leases lease ON lease.execution_id = execution.id
             WHERE execution.input_event_id = deliveries.event_id AND execution.project_id = deliveries.project_id
               AND execution.module_instance_id = deliveries.module_instance_id AND lease.status = 'active'
           )
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
          row.status !== "ineligible" && suspended?.suspended_at !== null && suspended !== undefined
            ? "suspended"
            : (row.status ?? "waiting-capacity"),
        reason:
          row.status !== "ineligible" && suspended?.suspended_at !== null && suspended !== undefined
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
           WHERE project_id = ? AND module_id = 'jarvis.module.development' AND consumed_at IS NULL
             AND attempt_count = 0
             AND id IN (SELECT delivery_id FROM development_admissions WHERE status <> 'ineligible')`,
        )
        .run(now, projectId);
    })();
  }

  public bind(projectId: string): DevelopmentAdmissionCapability {
    return {
      wasStarted: (repositoryId, workItemRef) =>
        this.wasStarted(projectId, repositoryId, workItemRef),
      wake: ({ repositoryId, workItemRef, observationRevision }) =>
        this.wake(projectId, repositoryId, workItemRef, observationRevision),
    };
  }

  private wasStarted(projectId: string, repositoryId: string, workItemRef: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1
           FROM workspace_leases leases
           JOIN executions execution ON execution.id = leases.execution_id
             AND execution.project_id = leases.project_id
           JOIN events ON events.id = execution.input_event_id AND events.project_id = execution.project_id
           WHERE leases.project_id = @projectId
             AND execution.module_id = 'jarvis.module.development'
             AND events.type = 'development.implementation.requested'
             AND json_extract(events.envelope, '$.payload.repositoryId') = @repositoryId
             AND json_extract(events.envelope, '$.payload.workItemRef') = @workItemRef
           LIMIT 1`,
        )
        .get({ projectId, repositoryId, workItemRef }) !== undefined
    );
  }

  private wake(
    projectId: string,
    repositoryId: string,
    workItemRef: string,
    observationRevision: number,
  ): void {
    const now = this.clock.now().toISOString();
    const request = `
      SELECT deliveries.id
      FROM deliveries
      JOIN events ON events.id = deliveries.event_id AND events.project_id = deliveries.project_id
      JOIN development_admissions admissions ON admissions.delivery_id = deliveries.id
      WHERE deliveries.project_id = @projectId
        AND deliveries.module_id = 'jarvis.module.development'
        AND events.type = 'development.implementation.requested'
        AND json_extract(events.envelope, '$.payload.repositoryId') = @repositoryId
        AND json_extract(events.envelope, '$.payload.workItemRef') = @workItemRef
        AND json_extract(events.envelope, '$.payload.requestedGeneration') < @observationRevision
        AND deliveries.consumed_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM workspace_leases leases
          JOIN executions execution ON execution.id = leases.execution_id
            AND execution.project_id = leases.project_id
          WHERE execution.input_event_id = deliveries.event_id
            AND execution.project_id = deliveries.project_id
        )`;
    this.db
      .prepare(
        `UPDATE development_admissions
         SET status = 'waiting-capacity', reason = 'awaiting-capacity', updated_at = @now
         WHERE status = 'ineligible' AND delivery_id IN (${request})`,
      )
      .run({ projectId, repositoryId, workItemRef, observationRevision, now });
    this.db
      .prepare(
        `UPDATE deliveries
         SET next_attempt_at = @now
         WHERE id IN (${request}) AND consumed_at IS NULL`,
      )
      .run({ projectId, repositoryId, workItemRef, observationRevision, now });
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
