-- Ticket #68: durable Workspace-owned leases. A partial unique index keeps
-- the active claim exclusive; retained and released history remains readable.
CREATE TABLE workspace_leases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  working_branch TEXT NOT NULL,
  base_revision_sha TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retained', 'released')),
  expires_at TEXT NOT NULL,
  cleanup_policy TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_pid INTEGER
) STRICT;

CREATE INDEX workspace_leases_project_id_status
  ON workspace_leases (project_id, status);

CREATE UNIQUE INDEX workspace_leases_active_project_repository_branch_unique
  ON workspace_leases (project_id, repository_id, working_branch)
  WHERE status = 'active';

CREATE UNIQUE INDEX workspace_leases_active_path_unique
  ON workspace_leases (workspace_path)
  WHERE status = 'active';
