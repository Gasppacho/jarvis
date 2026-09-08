-- Ticket #83: durable Execution progress for the Agent Runtime. These are
-- ledger rows, not integration Events: no Outbox row is created for a
-- checkpoint.
CREATE UNIQUE INDEX executions_id_project_id_unique
  ON executions (id, project_id);

CREATE TABLE execution_checkpoints (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  source_sequence INTEGER NOT NULL CHECK (source_sequence > 0),
  type TEXT NOT NULL CHECK (type IN ('agent.started', 'agent.message')),
  payload TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (project_id, execution_id, sequence),
  UNIQUE (project_id, execution_id, source_sequence),
  FOREIGN KEY (execution_id, project_id)
    REFERENCES executions (id, project_id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX execution_checkpoints_agent_started_once
  ON execution_checkpoints (project_id, execution_id)
  WHERE type = 'agent.started';
