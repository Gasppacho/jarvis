-- Ticket #89: validation progress is durable alongside Agent progress.
-- 0011 already shipped with a closed type CHECK, so rebuild it for upgrades.
CREATE TABLE execution_checkpoints_with_validation (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  source_sequence INTEGER NOT NULL CHECK (source_sequence > 0),
  type TEXT NOT NULL CHECK (type IN ('agent.started', 'agent.message', 'validation.started', 'validation.failed', 'commit.created')),
  payload TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (project_id, execution_id, sequence),
  UNIQUE (project_id, execution_id, source_sequence),
  FOREIGN KEY (execution_id, project_id)
    REFERENCES executions (id, project_id) ON DELETE CASCADE
) STRICT;

INSERT INTO execution_checkpoints_with_validation
  (project_id, execution_id, sequence, source_sequence, type, payload, occurred_at)
SELECT project_id, execution_id, sequence, source_sequence, type, payload, occurred_at
FROM execution_checkpoints;

DROP TABLE execution_checkpoints;
ALTER TABLE execution_checkpoints_with_validation RENAME TO execution_checkpoints;

CREATE UNIQUE INDEX execution_checkpoints_agent_started_once
  ON execution_checkpoints (project_id, execution_id)
  WHERE type = 'agent.started';
