-- Ticket #85: a timed-out Agent Runtime execution is terminal and must not
-- be redelivered as a generic failure.
CREATE TABLE inbox_with_timed_out_status (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  module_instance_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled', 'timed_out')),
  attempt INTEGER NOT NULL DEFAULT 1,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO inbox_with_timed_out_status
  (project_id, module_instance_id, event_id, status, attempt, result, created_at)
SELECT project_id, module_instance_id, event_id, status, attempt, result, created_at
FROM inbox;

DROP TABLE inbox;
ALTER TABLE inbox_with_timed_out_status RENAME TO inbox;

CREATE UNIQUE INDEX inbox_project_id_module_instance_id_event_id_unique
  ON inbox (project_id, module_instance_id, event_id);
