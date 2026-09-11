-- Ticket #156: a Delivery keeps the number of attempts already spent and the
-- earliest time its next attempt may run. Existing in-flight Deliveries have
-- spent no retry attempt yet and remain immediately eligible.
ALTER TABLE deliveries ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deliveries ADD COLUMN next_attempt_at TEXT;

CREATE INDEX deliveries_retry_due
  ON deliveries (consumed_at, next_attempt_at, created_at);
