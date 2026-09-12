-- Ticket #193: durable current readiness diagnostics and exactly-once admission.
CREATE TABLE github_work_item_readiness (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  module_instance_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  work_item_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'blocked', 'impossible')),
  reason TEXT NOT NULL,
  blocker_refs TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  admitted_at TEXT,
  PRIMARY KEY (project_id, module_instance_id, repository_id, work_item_ref)
) STRICT;
