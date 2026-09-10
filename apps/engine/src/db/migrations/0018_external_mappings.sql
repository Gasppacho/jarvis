-- Ticket #122: project-scoped idempotency for external resource mappings.
CREATE TABLE external_mappings (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  module_instance_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('attempted', 'completed')),
  resource_ref TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, module_instance_id, idempotency_key),
  CHECK (
    (status = 'attempted' AND resource_ref IS NULL)
    OR (status = 'completed' AND resource_ref IS NOT NULL)
  )
) STRICT;
