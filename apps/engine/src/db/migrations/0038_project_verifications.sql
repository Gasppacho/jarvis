CREATE TABLE project_verifications (
  project_id TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  verification_fingerprint TEXT NOT NULL,
  report TEXT NOT NULL,
  verified_at TEXT NOT NULL
) STRICT;
