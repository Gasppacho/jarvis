-- Ticket #161: remember that the currently claimed attempt was explicitly
-- requested as a Dead Letter replay. Automatic retries must clear this bit.
ALTER TABLE deliveries
  ADD COLUMN replay_requested INTEGER NOT NULL DEFAULT 0 CHECK (replay_requested IN (0, 1));

-- Preserve an in-flight replay claimed by a pre-0025 engine during upgrade.
UPDATE deliveries
SET replay_requested = 1
WHERE consumed_at IS NULL
  AND lease_owner LIKE 'replay-%';
