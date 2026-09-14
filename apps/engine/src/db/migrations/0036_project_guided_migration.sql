CREATE TABLE project_migration_state (
  project_id TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  source_fingerprint TEXT NOT NULL,
  plan TEXT NOT NULL,
  previewed_at TEXT NOT NULL,
  applied_at TEXT,
  history_id TEXT,
  previous_configuration TEXT,
  previous_bindings TEXT,
  resulting_configuration TEXT
) STRICT;
