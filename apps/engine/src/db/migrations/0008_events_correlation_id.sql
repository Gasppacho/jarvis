-- Ticket #59: GET /v1/projects/{projectId}/events filters by `correlationId`,
-- which the journal (0006_events_outbox_deliveries.sql) stores only inside
-- the `envelope` JSON document, not as a queryable column. Scanning every
-- row's envelope with `json_extract` on every request has no index to use;
-- a plain indexed column is simpler than an expression index and keeps the
-- filter an ordinary equality lookup. 0006 is immutable once applied, so
-- this is a new migration rather than an edit to it.
--
-- NOT NULL with a default: SQLite requires a non-NULL default to add a
-- NOT NULL column to a non-empty table. `''` is safe as a placeholder because
-- no real correlationId can ever be empty
-- (contracts/schemas/event-envelope.v1.schema.json requires `minLength: 8`
-- and the `^corr_` pattern) — so it can only ever mean "not yet backfilled",
-- never a real value. Non-nullable-by-construction is what makes it
-- impossible for `apps/engine/src/events/timeline.ts` to ever project a
-- `null` correlationId onto the wire, and lets it read the filter's own
-- column instead of the envelope so the two can never disagree (issue #59
-- code review, findings 2 and 3). New rows are written with this column
-- populated directly (apps/engine/src/events/dispatcher.ts), so it is never
-- left at the placeholder past this migration.
ALTER TABLE events ADD COLUMN correlation_id TEXT NOT NULL DEFAULT '';

-- Backfill existing rows from the envelope already on disk. Only rows still
-- at the placeholder are touched, so this UPDATE only ever does real work on
-- an upgrade. If an existing envelope's correlationId were ever missing or
-- malformed, `json_extract` returns NULL and this UPDATE fails the column's
-- own NOT NULL constraint — the migration aborts loudly instead of shipping
-- a silently corrupt row.
UPDATE events
SET correlation_id = json_extract(envelope, '$.correlationId')
WHERE correlation_id = '';

-- Covering the filtered, ordered, limited read `EventJournalReader.list`
-- issues (events/timeline.ts): leading `project_id` keeps a Project's
-- filtered read from ever touching another Project's rows
-- (docs/architecture/PERSISTENCE.md "Project scoping"), and carrying
-- `occurred_at DESC, id DESC` too means the index already holds the read's
-- entire ORDER BY, so satisfying it needs no separate temp b-tree sort.
-- Verified with EXPLAIN QUERY PLAN against this schema (issue #59 code
-- review, finding 5): SQLite only takes this path from a plain
-- `correlation_id = ?` equality in its own prepared statement — the
-- `@correlationId IS NULL OR correlation_id = @correlationId` single-
-- statement form defeats the planner even with this index present, which is
-- why `EventJournalReader.list` now prepares a filtered and an unfiltered
-- statement instead of one with that OR.
CREATE INDEX events_project_id_correlation_id_occurred_at
  ON events (project_id, correlation_id, occurred_at DESC, id DESC);
