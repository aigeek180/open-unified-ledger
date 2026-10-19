-- Settlement instruction matching (SPEC.md §5.4, §5.5). A buyer co-signs an
-- issue or a trade only if its own operator affirmed it first, under the same
-- UETR and with the same terms: what it pays and receives is never decided by
-- the counterparty alone.
CREATE TABLE affirmations (
  uetr        text PRIMARY KEY CHECK (uetr ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  flow        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
