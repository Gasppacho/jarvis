import type Database from "better-sqlite3";
import type { Clock } from "../../kernel/src/clock.js";
import type { IdGenerator } from "../../kernel/src/id-generator.js";

export type WorkspaceLeaseStatus = "active" | "retained" | "released";

export interface CreateWorkspaceLeaseInput {
  readonly projectId: string;
  readonly executionId: string;
  readonly repositoryId: string;
  readonly workingBranch: string;
  readonly baseRevisionSha: string;
  readonly workspacePath: string;
  readonly expiresAt: string;
  readonly cleanupPolicy: string;
  readonly ownerPid?: number | null;
}

export interface WorkspaceLease {
  readonly id: string;
  readonly projectId: string;
  readonly executionId: string;
  readonly repositoryId: string;
  readonly workingBranch: string;
  readonly baseRevisionSha: string;
  readonly workspacePath: string;
  readonly status: WorkspaceLeaseStatus;
  readonly expiresAt: string;
  readonly cleanupPolicy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly ownerPid: number | null;
}

interface WorkspaceLeaseRow {
  readonly id: string;
  readonly project_id: string;
  readonly execution_id: string;
  readonly repository_id: string;
  readonly working_branch: string;
  readonly base_revision_sha: string;
  readonly workspace_path: string;
  readonly status: string;
  readonly expires_at: string;
  readonly cleanup_policy: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly owner_pid: number | null;
}

export class WorkspaceLeaseRepository {
  public constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  public create(input: CreateWorkspaceLeaseInput): WorkspaceLease {
    const now = this.clock.now().toISOString();
    const lease = {
      id: `lease_${this.ids.next()}`,
      ...input,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
      ownerPid: input.ownerPid ?? null,
    };

    this.db
      .prepare(
        `INSERT INTO workspace_leases
         (id, project_id, execution_id, repository_id, working_branch, base_revision_sha,
          workspace_path, status, expires_at, cleanup_policy, created_at, updated_at, owner_pid)
         VALUES (@id, @projectId, @executionId, @repositoryId, @workingBranch, @baseRevisionSha,
          @workspacePath, @status, @expiresAt, @cleanupPolicy, @createdAt, @updatedAt, @ownerPid)`,
      )
      .run(lease);

    return lease;
  }

  public findByExecution(projectId: string, executionId: string): WorkspaceLease | undefined {
    const row = this.db
      .prepare(
        `SELECT id, project_id, execution_id, repository_id, working_branch, base_revision_sha,
                workspace_path, status, expires_at, cleanup_policy, created_at, updated_at, owner_pid
         FROM workspace_leases
         WHERE project_id = @projectId AND execution_id = @executionId
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get({ projectId, executionId }) as WorkspaceLeaseRow | undefined;
    return row === undefined ? undefined : toLease(row);
  }

  public listActive(projectId: string): WorkspaceLease[] {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, execution_id, repository_id, working_branch, base_revision_sha,
                workspace_path, status, expires_at, cleanup_policy, created_at, updated_at, owner_pid
         FROM workspace_leases
         WHERE project_id = @projectId AND status = 'active'
         ORDER BY created_at ASC, id ASC`,
      )
      .all({ projectId }) as WorkspaceLeaseRow[];
    return rows.map(toLease);
  }

  public markRetained(projectId: string, leaseId: string): WorkspaceLease | undefined {
    this.db
      .prepare(
        `UPDATE workspace_leases
         SET status = 'retained', updated_at = @updatedAt
         WHERE project_id = @projectId AND id = @leaseId AND status = 'active'`,
      )
      .run({ projectId, leaseId, updatedAt: this.clock.now().toISOString() });
    return this.findById(projectId, leaseId);
  }

  public release(projectId: string, leaseId: string): WorkspaceLease | undefined {
    this.db
      .prepare(
        `UPDATE workspace_leases
         SET status = 'released', updated_at = @updatedAt
         WHERE project_id = @projectId AND id = @leaseId
           AND status IN ('active', 'retained')`,
      )
      .run({ projectId, leaseId, updatedAt: this.clock.now().toISOString() });
    return this.findById(projectId, leaseId);
  }

  private findById(projectId: string, leaseId: string): WorkspaceLease | undefined {
    const row = this.db
      .prepare(
        `SELECT id, project_id, execution_id, repository_id, working_branch, base_revision_sha,
                workspace_path, status, expires_at, cleanup_policy, created_at, updated_at, owner_pid
         FROM workspace_leases
         WHERE project_id = @projectId AND id = @leaseId`,
      )
      .get({ projectId, leaseId }) as WorkspaceLeaseRow | undefined;
    return row === undefined ? undefined : toLease(row);
  }
}

function toLease(row: WorkspaceLeaseRow): WorkspaceLease {
  return {
    id: row.id,
    projectId: row.project_id,
    executionId: row.execution_id,
    repositoryId: row.repository_id,
    workingBranch: row.working_branch,
    baseRevisionSha: row.base_revision_sha,
    workspacePath: row.workspace_path,
    status: row.status as WorkspaceLeaseStatus,
    expiresAt: row.expires_at,
    cleanupPolicy: row.cleanup_policy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ownerPid: row.owner_pid,
  };
}
