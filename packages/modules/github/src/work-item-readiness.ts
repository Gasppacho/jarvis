import type Database from "better-sqlite3";
import type { Clock } from "../../../kernel/src/clock.js";
import type { WorkItemReadinessCapability } from "../../../module-sdk/src/index.js";

/** GitHub Module state: current readiness diagnostics and one-time admission. */
export class WorkItemReadinessStore {
  public constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
  ) {}

  public bind(projectId: string, moduleInstanceId: string): WorkItemReadinessCapability {
    return {
      observe: ({ repositoryId, workItemRef, status, reason, blockerRefs, observedAt }) => {
        this.db
          .prepare(
            `INSERT INTO github_work_item_readiness
               (project_id, module_instance_id, repository_id, work_item_ref, status, reason, blocker_refs, observed_at, admitted_at)
             VALUES (@projectId, @moduleInstanceId, @repositoryId, @workItemRef, @status, @reason, @blockerRefs, @observedAt, NULL)
             ON CONFLICT (project_id, module_instance_id, repository_id, work_item_ref) DO UPDATE SET
               status = excluded.status,
               reason = excluded.reason,
               blocker_refs = excluded.blocker_refs,
               observed_at = excluded.observed_at`,
          )
          .run({
            projectId,
            moduleInstanceId,
            repositoryId,
            workItemRef,
            status,
            reason,
            blockerRefs: JSON.stringify(blockerRefs),
            observedAt,
          });
        if (status !== "ready") return false;
        return (
          this.db
            .prepare(
              `UPDATE github_work_item_readiness
               SET admitted_at = @admittedAt
               WHERE project_id = @projectId AND module_instance_id = @moduleInstanceId
                 AND repository_id = @repositoryId AND work_item_ref = @workItemRef
                 AND status = 'ready' AND admitted_at IS NULL`,
            )
            .run({
              projectId,
              moduleInstanceId,
              repositoryId,
              workItemRef,
              admittedAt: this.clock.now().toISOString(),
            }).changes === 1
        );
      },
    };
  }
}
