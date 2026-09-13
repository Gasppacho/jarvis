-- Ticket #223: late observed facts must not overwrite a newer readiness state.
ALTER TABLE github_work_item_readiness
  ADD COLUMN observation_revision INTEGER NOT NULL DEFAULT 0
  CHECK (observation_revision >= 0);
