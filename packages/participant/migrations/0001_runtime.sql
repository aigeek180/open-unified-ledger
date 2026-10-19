-- The participant runtime's own tables, beside the core ledger in the same
-- schema (SPEC.md §4.3). They hold work and evidence, not balances: balances
-- live only in the journal.

-- Every instruction this participant initiated or approved. For the
-- initiator it is the outbox: written in the same transaction as the pending
-- journal entry, then submitted. For an approver it records what it signed.
CREATE TABLE instructions (
  uetr          text PRIMARY KEY CHECK (uetr ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  role          text NOT NULL CHECK (role IN ('submitter', 'approver', 'party')),
  flow          jsonb NOT NULL,
  approvals     jsonb NOT NULL DEFAULT '[]',
  entry_key     text NOT NULL,
  status        text NOT NULL CHECK (status IN ('ready', 'submitted', 'awaiting', 'settled', 'failed', 'expired')),
  deadline      timestamptz NOT NULL,
  tx_hash       text,
  settled_block bigint,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX instructions_open_idx ON instructions (status, deadline)
  WHERE status IN ('ready', 'submitted', 'awaiting');

-- The last block the listener has fully processed.
CREATE TABLE chain_cursor (
  singleton   boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_block  bigint NOT NULL
);

-- What the listener saw on chain and could not book: a movement no
-- instruction of ours explains, or one that differs from what we booked.
-- Breaks are shown, never corrected automatically.
CREATE TABLE chain_breaks (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  block        bigint NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('unexplained', 'mismatch')),
  uetr         text,
  tx_hash      text NOT NULL,
  detail       jsonb NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX chain_breaks_block_idx ON chain_breaks (block);

-- Each reconciliation: the books against the chain at one block.
CREATE TABLE reconciliation_runs (
  block       bigint PRIMARY KEY,
  ok          boolean NOT NULL,
  checks      jsonb NOT NULL,
  checked_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
