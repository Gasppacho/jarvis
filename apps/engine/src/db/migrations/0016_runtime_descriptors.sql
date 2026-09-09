-- Ticket #99: machine-local Runtime Registry descriptors. Runtime state is
-- global engine state, not part of any project's portable configuration.
CREATE TABLE runtime_descriptors (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  executable_path TEXT,
  version TEXT,
  capabilities TEXT NOT NULL CHECK (json_valid(capabilities) AND json_type(capabilities) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('available', 'unavailable', 'unauthenticated', 'degraded'))
) STRICT;
