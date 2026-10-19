-- FX quotes for payment versus payment (SPEC.md §13). The dealer keeps every
-- quote it signed; the payer's bank keeps every quote it asked for. A quote
-- settles at most one payment: the first instruction to claim it holds it.
CREATE TABLE fx_quotes (
  id          text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  role        text NOT NULL CHECK (role IN ('dealer', 'requester')),
  quote       jsonb NOT NULL,
  uetr        text UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX fx_quotes_created_idx ON fx_quotes (created_at DESC, id DESC);
