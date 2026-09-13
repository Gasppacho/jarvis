-- Ticket #221: provider-neutral GitHub Work Item snapshots and monotone revisions.
CREATE TABLE github_work_item_observations (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  work_item_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'unknown')),
  tags TEXT NOT NULL,
  dependencies_status TEXT NOT NULL CHECK (dependencies_status IN ('complete', 'unknown')),
  open_work_item_refs TEXT NOT NULL,
  verification TEXT NOT NULL CHECK (verification IN ('verified', 'unavailable')),
  reason_code TEXT,
  observed_at TEXT NOT NULL,
  observation_revision INTEGER NOT NULL CHECK (observation_revision > 0),
  PRIMARY KEY (project_id, repository_id, work_item_ref)
) STRICT;
