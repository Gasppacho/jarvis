-- A failure while inserting an Execution must still be dead-letterable. In
-- that rare case there is no execution id to reference; NULL records that
-- fact instead of losing the Delivery's original failure.
CREATE TABLE dead_letters_rebuilt (
  delivery_id TEXT PRIMARY KEY REFERENCES deliveries (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  module_instance_id TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  last_execution_id TEXT REFERENCES executions (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO dead_letters_rebuilt
  (delivery_id, project_id, event_id, module_instance_id, code, message, attempts, last_execution_id, created_at)
SELECT delivery_id, project_id, event_id, module_instance_id, code, message, attempts, last_execution_id, created_at
FROM dead_letters;

DROP TABLE dead_letters;
ALTER TABLE dead_letters_rebuilt RENAME TO dead_letters;

CREATE INDEX dead_letters_project_id_created_at
  ON dead_letters (project_id, created_at DESC, delivery_id DESC);
