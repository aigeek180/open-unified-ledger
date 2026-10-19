-- Signing keys and administrative changes (SPEC.md §15).

-- The keys this participant has signed with, by generation: the active one,
-- a next one waiting for the registry to admit it, and those retired. The
-- runtime signs with the active key, and moves to the next once the registry
-- shows it admitted.
CREATE TABLE signing_keys (
  generation  integer PRIMARY KEY CHECK (generation > 0),
  address     text NOT NULL UNIQUE CHECK (address ~ '^0x[0-9a-f]{40}$'),
  status      text NOT NULL CHECK (status IN ('active', 'pending', 'retired')),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at  timestamptz
);
CREATE UNIQUE INDEX signing_keys_one_active ON signing_keys (status) WHERE status = 'active';

-- An administrative change an operator started here, or another participant
-- asked of this one: what it is, where it stands under the policy, and what
-- applying it did.
CREATE TABLE changes (
  id          text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  action      text NOT NULL,
  request     jsonb NOT NULL,
  initiator   text NOT NULL,
  status      text NOT NULL CHECK (status IN ('proposed', 'approved', 'requested', 'applied', 'failed', 'rejected', 'expired')),
  result      jsonb,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX changes_created_idx ON changes (created_at DESC);
