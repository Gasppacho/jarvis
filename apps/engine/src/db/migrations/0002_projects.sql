-- Owned by the Project Runtime (docs/architecture/PERSISTENCE.md).
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL,
  portable_config TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;

-- Local, machine-specific and never committed: the absolute repository path
-- lives here, never in the portable configuration.
CREATE TABLE project_bindings (
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  path          TEXT NOT NULL,
  bookmark_ref  TEXT,
  PRIMARY KEY (project_id, repository_id)
) STRICT;

-- One repository belongs to at most one project, so a re-import is refused
-- rather than silently duplicated.
CREATE UNIQUE INDEX project_bindings_path ON project_bindings (path);
