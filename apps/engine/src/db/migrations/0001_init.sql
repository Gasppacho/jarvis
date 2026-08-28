-- Engine-owned metadata. Contexts own their own tables from Ticket 03 onward.
CREATE TABLE engine_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
