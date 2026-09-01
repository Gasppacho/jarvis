-- Project Registry tables (PERSISTENCE.md logical ownership: Project Runtime).
-- `projects` holds the portable, machine-independent configuration; the machine
-- specific bits (absolute repository path, bookmark) live only in
-- `project_bindings` (docs/architecture/PROJECTS.md).
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'valid', 'active', 'paused', 'invalid', 'degraded', 'archived')),
  portable_config TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE project_bindings (
  project_id TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  -- Canonical (realpath-resolved) absolute path: the repository on this machine.
  repository_path TEXT NOT NULL,
  -- Opaque reference to bookmark bytes owned by the macOS Shell; legacy imports may be nil.
  bookmark_ref TEXT
) STRICT;

-- One working tree is one project: the same canonical path must never be bound twice,
-- including the same tree reached through a symlink (which canonicalises to this path).
CREATE UNIQUE INDEX project_bindings_repository_path_unique ON project_bindings (repository_path);
