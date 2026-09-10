-- Ticket #110: global connection descriptors. Credentials stay outside Jarvis;
-- this table stores only the opaque reference used to resolve one later.
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_label TEXT NOT NULL,
  capabilities TEXT NOT NULL CHECK (json_valid(capabilities) AND json_type(capabilities) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('available', 'unauthenticated', 'unavailable', 'revoked')),
  secret_ref TEXT NOT NULL
) STRICT;
