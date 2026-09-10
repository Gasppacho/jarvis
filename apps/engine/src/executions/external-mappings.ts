import type Database from "better-sqlite3";
import type { Clock } from "../../../../packages/kernel/src/clock.js";
import type {
  ExternalMappingCapability,
  ExternalMappingRecord,
} from "../../../../packages/module-sdk/src/index.js";

interface ExternalMappingRow {
  readonly status: ExternalMappingRecord["status"];
  readonly resource_ref: string | null;
}

/** Durable project/module-scoped mappings for idempotent external requests. */
export class ExternalMappingStore {
  public constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
  ) {}

  public bind(projectId: string, moduleInstanceId: string): ExternalMappingCapability {
    const pending = new Map<string, string>();
    const recordResource = (idempotencyKey: string, resourceRef: string): void => {
      this.db
        .prepare(
          `INSERT INTO external_mappings
             (project_id, module_instance_id, idempotency_key, status, resource_ref, created_at)
           VALUES (@projectId, @moduleInstanceId, @idempotencyKey, 'completed', @resourceRef, @createdAt)
           ON CONFLICT (project_id, module_instance_id, idempotency_key) DO UPDATE SET
             status = 'completed',
             resource_ref = excluded.resource_ref
           WHERE external_mappings.resource_ref IS NULL`,
        )
        .run({
          projectId,
          moduleInstanceId,
          idempotencyKey,
          resourceRef,
          createdAt: this.clock.now().toISOString(),
        });
    };

    return {
      recordAttempt: (idempotencyKey) => {
        this.db
          .prepare(
            `INSERT INTO external_mappings
               (project_id, module_instance_id, idempotency_key, status, resource_ref, created_at)
             VALUES (@projectId, @moduleInstanceId, @idempotencyKey, 'attempted', NULL, @createdAt)
             ON CONFLICT (project_id, module_instance_id, idempotency_key) DO NOTHING`,
          )
          .run({
            projectId,
            moduleInstanceId,
            idempotencyKey,
            createdAt: this.clock.now().toISOString(),
          });
      },
      recordResource: ({ idempotencyKey, resourceRef }) => {
        if (this.db.inTransaction) {
          recordResource(idempotencyKey, resourceRef);
        } else {
          pending.set(idempotencyKey, resourceRef);
        }
      },
      read: (idempotencyKey) => {
        const pendingResource = pending.get(idempotencyKey);
        if (pendingResource !== undefined) {
          return { status: "completed", resourceRef: pendingResource };
        }
        const row = this.db
          .prepare(
            `SELECT status, resource_ref
             FROM external_mappings
             WHERE project_id = @projectId
               AND module_instance_id = @moduleInstanceId
               AND idempotency_key = @idempotencyKey`,
          )
          .get({ projectId, moduleInstanceId, idempotencyKey }) as ExternalMappingRow | undefined;
        if (row === undefined) return undefined;
        return row.resource_ref === null
          ? { status: row.status }
          : { status: row.status, resourceRef: row.resource_ref };
      },
      flushPending: () => {
        for (const [idempotencyKey, resourceRef] of pending) {
          recordResource(idempotencyKey, resourceRef);
        }
        pending.clear();
      },
    };
  }
}
