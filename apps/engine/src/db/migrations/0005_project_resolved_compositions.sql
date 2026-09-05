-- Ticket #53: the immutable Resolved Project frozen at Project activation
-- (docs/architecture/PROJECTS.md "Activation"). One row per Project: a repeat
-- activation of the same `composition_fingerprint` leaves this row untouched
-- (application code checks the fingerprint before writing); activating a
-- genuinely different, newly-valid composition supersedes it. History across
-- activations is not retained in this slice.
CREATE TABLE project_resolved_compositions (
  project_id TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  composition_fingerprint TEXT NOT NULL,
  resolved_project TEXT NOT NULL,
  activated_at TEXT NOT NULL
) STRICT;
