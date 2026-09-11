-- Ticket #130: durable GitHub Module polling position per Project, Module
-- Instance and repository.
CREATE TABLE github_cursors (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  module_instance_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_timestamp TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, module_instance_id, repository_id)
) STRICT;
