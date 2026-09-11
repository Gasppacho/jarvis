-- Ticket #161: keep an audit bit on the Execution Ledger for an explicit
-- Dead Letter replay without changing the Local API ExecutionSummary shape.
ALTER TABLE executions ADD COLUMN replayed INTEGER NOT NULL DEFAULT 0 CHECK (replayed IN (0, 1));
