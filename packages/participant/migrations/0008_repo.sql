-- Repo (SPEC.md §5.7–§5.10, invariant 14). Each bank's record of the repos it
-- is party to: the terms both sides affirmed, and the collateral the lender
-- holds now. The record moves only in the same transaction as the listener
-- posts a repo instruction the chain settled, and its history keeps the
-- record after each one, so the record at any block (a coupon's record
-- block, for a manufactured payment) can be read back.
CREATE TABLE repos (
  id            text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  role          text NOT NULL CHECK (role IN ('lender', 'borrower')),
  counterparty  text NOT NULL,
  terms         jsonb NOT NULL,
  collateral    jsonb NOT NULL,
  status        text NOT NULL CHECK (status IN ('open', 'closed')),
  opened_block  bigint NOT NULL,
  closed_block  bigint,
  updated_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE repo_records (
  repo        text NOT NULL REFERENCES repos (id),
  uetr        text NOT NULL,
  kind        text NOT NULL,
  block       bigint NOT NULL,
  collateral  jsonb NOT NULL,
  PRIMARY KEY (repo, uetr)
);
CREATE INDEX repo_records_block_idx ON repo_records (repo, block);

-- Margin calls: a margin the side receiving units affirmed at agreed marks,
-- and told the other side of. It is met when its instruction settles, and
-- overdue once block time passes `due_by` with it unmet, on both sides.
CREATE TABLE margin_calls (
  uetr        text PRIMARY KEY,
  repo        text NOT NULL,
  flow        jsonb NOT NULL,
  caller      text NOT NULL,
  due_by      bigint NOT NULL,
  notified    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
