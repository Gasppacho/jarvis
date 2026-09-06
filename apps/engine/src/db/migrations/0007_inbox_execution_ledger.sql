-- Ticket #57: the consumer-side Inbox and the Execution Ledger's
-- `executions` table (docs/architecture/PERSISTENCE.md "Inbox", "Logical
-- ownership"; docs/architecture/EXECUTIONS.md). `execution_steps` and
-- `execution_logs` are not created here: no #57 acceptance criterion reads
-- progress steps or structured logs, only the Execution's Project, Module
-- Instance, input event, attempt and terminal outcome — so those two wait
-- for whichever ticket actually needs them.

-- Marks a Delivery as consumed once its transaction (Inbox insert + Module
-- state mutation + Execution update + outgoing Outbox rows) has committed
-- (docs/architecture/PERSISTENCE.md "Consume and publish" step 5).
ALTER TABLE deliveries ADD COLUMN consumed_at TEXT;

-- The consumer-side deduplication record for a Delivery
-- (docs/architecture/PERSISTENCE.md "Inbox"; packages/eventing/CONTEXT.md).
-- Unique per Project, consuming Module Instance and event id — never per
-- event alone, so the same event delivered to two different Module
-- Instances gets two independent rows (issue #57 acceptance criteria). The
-- terminal `status`/`result` let a redelivery of the same event id to the
-- same consumer return the recorded outcome instead of re-running the
-- handler; `attempt` is carried per docs/architecture/PERSISTENCE.md
-- "Execution logs" wording ("Le record conserve statut, attempt, résultat
-- terminal et timestamps").
CREATE TABLE inbox (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  module_instance_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 1,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX inbox_project_id_module_instance_id_event_id_unique
  ON inbox (project_id, module_instance_id, event_id);

-- The Execution Ledger (docs/architecture/EXECUTIONS.md): one durable
-- invocation of one Module Instance's handler for one input event. #57 only
-- ever produces `completed` or `failed` — the sample Module's handler is
-- synchronous and its Execution reaches a terminal state inside the same
-- transaction as the handler call, honoring the finite work invariant — but
-- the CHECK keeps the full documented state machine so a later ticket that
-- produces `queued`/`running`/`cancelling`/`cancelled`/`timed_out` is not
-- blocked on a schema change.
CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  module_instance_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  input_event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'timed_out')
  ),
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

-- Leads with `project_id` (docs/architecture/PERSISTENCE.md "Project
-- scoping"): the Execution Ledger is queryable per Project (issue #57
-- acceptance criteria).
CREATE INDEX executions_project_id_created_at ON executions (project_id, created_at);
