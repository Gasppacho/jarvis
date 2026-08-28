-- Engine-scoped key/value state. Project, event and execution tables arrive with
-- the tickets that own them; PERSISTENCE.md keeps one owner per table.
CREATE TABLE engine_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

INSERT INTO engine_metadata (key, value) VALUES ('schema_initialized_at', datetime('now'));
