-- Ticket #162: a Delivery is invisible to another worker while a live lease
-- protects the handler invocation. Expiry makes a crashed worker reclaimable.
ALTER TABLE deliveries ADD COLUMN lease_owner TEXT;
ALTER TABLE deliveries ADD COLUMN lease_expires_at TEXT;

CREATE INDEX deliveries_claimable
  ON deliveries (consumed_at, next_attempt_at, lease_expires_at, created_at);
