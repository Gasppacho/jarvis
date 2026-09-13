-- L01: record check outcomes and each repair without discarding earlier evidence.
CREATE TABLE execution_checkpoints_with_outcomes (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  source_sequence INTEGER NOT NULL CHECK (source_sequence > 0),
  type TEXT NOT NULL CHECK (type IN ('preparation.started', 'preparation.completed', 'preparation.failed', 'agent.started', 'agent.repair-started', 'agent.message', 'validation.started', 'validation.completed', 'validation.failed', 'commit.created', 'branch.pushed')),
  payload TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (project_id, execution_id, sequence),
  UNIQUE (project_id, execution_id, source_sequence),
  FOREIGN KEY (execution_id, project_id)
    REFERENCES executions (id, project_id) ON DELETE CASCADE
) STRICT;

INSERT INTO execution_checkpoints_with_outcomes
  (project_id, execution_id, sequence, source_sequence, type, payload, occurred_at)
SELECT project_id, execution_id, sequence, source_sequence, type, payload, occurred_at
FROM execution_checkpoints;

DROP TABLE execution_checkpoints;
ALTER TABLE execution_checkpoints_with_outcomes RENAME TO execution_checkpoints;

CREATE UNIQUE INDEX execution_checkpoints_agent_started_once
  ON execution_checkpoints (project_id, execution_id)
  WHERE type = 'agent.started';
