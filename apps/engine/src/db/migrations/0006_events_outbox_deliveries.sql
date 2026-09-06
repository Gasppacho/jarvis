-- Ticket #56: the Eventing tables PERSISTENCE.md assigns to this context.
-- Inbox and dead_letters arrive with #57 and #17, which add handler
-- invocation and retries; nothing here assumes either exists yet.

-- The transactionally recorded set of Events awaiting publication
-- (docs/architecture/EVENTS.md "Event transaction rule"). One row per
-- envelope, keyed by its own event id so a redelivered publication cannot
-- create a second row.
CREATE TABLE outbox (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  envelope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched')) DEFAULT 'pending',
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  dispatched_at TEXT
) STRICT;

CREATE INDEX outbox_project_id_status ON outbox (project_id, status);
-- The dispatcher claims pending work across every Project, so its own
-- working index leads with `status` rather than `project_id`; the index
-- above is what keeps a project-scoped read (e.g. a future outbox backlog
-- view) from scanning every Project's rows.
CREATE INDEX outbox_status_created_at ON outbox (status, created_at);

-- The canonical durable event journal (docs/architecture/PERSISTENCE.md
-- "Event store versus event log"): append-only, keyed by the envelope's own
-- event id so a second dispatch attempt for the same event never journals it
-- twice.
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('request', 'fact')),
  envelope TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
) STRICT;

CREATE INDEX events_project_id_occurred_at ON events (project_id, occurred_at);

-- The durable assignment of one Event to one Module Instance consumer. The
-- unique index is the idempotency guard: redispatching the same event id
-- must not fan a consumer out a second Delivery.
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  module_instance_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX deliveries_event_id_module_instance_id_unique
  ON deliveries (event_id, module_instance_id);
CREATE INDEX deliveries_project_id_event_id ON deliveries (project_id, event_id);
