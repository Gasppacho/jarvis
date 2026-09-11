-- Ticket #157: a Delivery that cannot be retried any further gets one durable
-- terminal record. The last Execution remains in the Execution Ledger; this
-- row carries the operator-facing reason and the project-scoped lookup key.
CREATE TABLE dead_letters (
  delivery_id TEXT PRIMARY KEY REFERENCES deliveries (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  module_instance_id TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  last_execution_id TEXT NOT NULL REFERENCES executions (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX dead_letters_project_id_created_at
  ON dead_letters (project_id, created_at DESC, delivery_id DESC);
