-- Ticket #199: durable display metadata and provider polling health for the
-- Project Overview. The readiness row remains the source of truth for the
-- latest issue snapshot; these columns only make that snapshot renderable.
ALTER TABLE github_work_item_readiness ADD COLUMN issue_number INTEGER;
ALTER TABLE github_work_item_readiness ADD COLUMN title TEXT;
ALTER TABLE github_work_item_readiness ADD COLUMN tag TEXT;
ALTER TABLE github_work_item_readiness ADD COLUMN rule_matches INTEGER NOT NULL DEFAULT 1
  CHECK (rule_matches IN (0, 1));

CREATE TABLE github_polling_status (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  module_instance_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('live', 'reconnecting', 'failed')),
  last_poll_at TEXT,
  error_reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, module_instance_id, repository_id)
) STRICT;
