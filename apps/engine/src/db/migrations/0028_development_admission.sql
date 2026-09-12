-- Development admission remains attached to the durable Delivery, never an in-memory queue.
CREATE TABLE development_admission_controls (
  project_id TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  suspended_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE development_admissions (
  delivery_id TEXT PRIMARY KEY REFERENCES deliveries (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('waiting-capacity', 'blocked', 'impossible', 'ineligible', 'suspended')),
  reason TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX development_admissions_project_id_updated_at
  ON development_admissions (project_id, updated_at);
