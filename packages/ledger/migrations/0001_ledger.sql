-- The core ledger: one participant's double-entry books (SPEC.md §4.3).
--
-- Every rule that keeps the books correct lives here, so a bug in
-- application code cannot break it:
--   * every entry balances in each currency, with at least two lines;
--   * lines post only to leaf accounts of the same currency;
--   * history is append-only: lines never change, an entry only moves
--     pending -> posted or pending -> voided, nothing is deleted;
--   * instants and block numbers never go backwards, so an as-of answer,
--     once given, never changes;
--   * a posted entry that touches a mirrored account carries the block it
--     settled in, so the reconciler can compare it with the chain.
-- Amounts are integer minor units in bigint; never floating point.

CREATE TABLE accounts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  type        text NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  currency    char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  control     boolean NOT NULL,
  mirrored    boolean NOT NULL,
  parent_id   bigint REFERENCES accounts (id),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  postable    boolean GENERATED ALWAYS AS (NOT control) STORED,
  UNIQUE (id, currency, postable)
);
CREATE INDEX accounts_parent_idx ON accounts (parent_id);

CREATE TABLE journal_entries (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key  text NOT NULL UNIQUE,
  payload_hash     text NOT NULL,
  description      text NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending', 'posted', 'voided')),
  -- Business instants. created_at starts a pending entry; posted_at and
  -- voided_at end it. An entry posted directly has created_at = posted_at.
  created_at       timestamptz NOT NULL,
  posted_at        timestamptz,
  voided_at        timestamptz,
  -- The shared-ledger block the entry's on-chain counterpart committed in.
  ledger_block     bigint CHECK (ledger_block >= 0),
  -- Bookkeeping: when this row was written, and by which transaction.
  recorded_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  txid             bigint NOT NULL DEFAULT pg_current_xact_id()::text::bigint,
  CHECK ((status = 'posted') = (posted_at IS NOT NULL)),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
  CHECK (posted_at >= created_at),
  CHECK (voided_at >= created_at),
  CHECK (ledger_block IS NULL OR status = 'posted')
);
CREATE INDEX journal_entries_posted_idx ON journal_entries (posted_at) WHERE status = 'posted';
CREATE INDEX journal_entries_block_idx ON journal_entries (ledger_block) WHERE ledger_block IS NOT NULL;
CREATE INDEX journal_entries_pending_idx ON journal_entries (created_at) WHERE status <> 'posted';

CREATE TABLE journal_lines (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id    bigint NOT NULL REFERENCES journal_entries (id),
  account_id  bigint NOT NULL,
  currency    char(3) NOT NULL,
  side        text NOT NULL CHECK (side IN ('debit', 'credit')),
  amount      bigint NOT NULL CHECK (amount > 0),
  -- Only a postable (leaf) account of the line's currency can be referenced.
  postable    boolean NOT NULL GENERATED ALWAYS AS (true) STORED,
  FOREIGN KEY (account_id, currency, postable) REFERENCES accounts (id, currency, postable)
);
CREATE INDEX journal_lines_entry_idx ON journal_lines (entry_id);
CREATE INDEX journal_lines_account_idx ON journal_lines (account_id, entry_id);

-- The latest instant and block recorded. Updating this one row serializes
-- writers, which is what makes the monotonic checks below safe.
CREATE TABLE ledger_clock (
  singleton     boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_instant  timestamptz NOT NULL DEFAULT '-infinity',
  last_block    bigint NOT NULL DEFAULT -1
);
INSERT INTO ledger_clock DEFAULT VALUES;

-- Accounts: a child shares its control parent's type, currency and mirroring;
-- only the name may change; nothing is deleted.
CREATE FUNCTION ledger_accounts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_parent accounts%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger: accounts are never deleted (%)', OLD.code;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.code, NEW.type, NEW.currency, NEW.control, NEW.mirrored, NEW.parent_id)
       IS DISTINCT FROM (OLD.code, OLD.type, OLD.currency, OLD.control, OLD.mirrored, OLD.parent_id) THEN
      RAISE EXCEPTION 'ledger: only an account''s name can change (%)', OLD.code;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO v_parent FROM accounts WHERE id = NEW.parent_id;
    IF NOT v_parent.control THEN
      RAISE EXCEPTION 'ledger: parent % of % is not a control account', v_parent.code, NEW.code;
    END IF;
    IF (NEW.type, NEW.currency, NEW.mirrored) IS DISTINCT FROM (v_parent.type, v_parent.currency, v_parent.mirrored) THEN
      RAISE EXCEPTION 'ledger: % must share type, currency and mirroring with its parent %', NEW.code, v_parent.code;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accounts_guard BEFORE INSERT OR UPDATE OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION ledger_accounts_guard();

-- Entries: inserted pending or posted; then one transition at most.
-- Trigger names order them: a_guard runs before b_clock.
CREATE FUNCTION ledger_entries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger: journal entries are never deleted (entry %)', OLD.id;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'voided' THEN
      RAISE EXCEPTION 'ledger: an entry cannot be created voided';
    END IF;
    IF NEW.status = 'posted' AND NEW.posted_at <> NEW.created_at THEN
      RAISE EXCEPTION 'ledger: an entry posted directly is posted when it is created';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'ledger: entry % is % and can no longer change', OLD.id, OLD.status;
  END IF;
  IF NEW.status NOT IN ('posted', 'voided') THEN
    RAISE EXCEPTION 'ledger: a pending entry can only be posted or voided (entry %)', OLD.id;
  END IF;
  IF (NEW.id, NEW.idempotency_key, NEW.payload_hash, NEW.description, NEW.created_at, NEW.recorded_at, NEW.txid)
     IS DISTINCT FROM (OLD.id, OLD.idempotency_key, OLD.payload_hash, OLD.description, OLD.created_at, OLD.recorded_at, OLD.txid) THEN
    RAISE EXCEPTION 'ledger: only an entry''s status, its instant and its block change (entry %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER a_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_guard();

CREATE FUNCTION ledger_entries_clock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_clock ledger_clock%ROWTYPE;
  v_instant timestamptz;
BEGIN
  v_instant := CASE
    WHEN TG_OP = 'INSERT' THEN NEW.created_at
    ELSE COALESCE(NEW.posted_at, NEW.voided_at)
  END;
  SELECT * INTO v_clock FROM ledger_clock FOR UPDATE;
  IF v_instant < v_clock.last_instant THEN
    RAISE EXCEPTION 'ledger: instant % is earlier than the last recorded instant %', v_instant, v_clock.last_instant;
  END IF;
  IF NEW.ledger_block < v_clock.last_block THEN
    RAISE EXCEPTION 'ledger: block % is earlier than the last recorded block %', NEW.ledger_block, v_clock.last_block;
  END IF;
  UPDATE ledger_clock
     SET last_instant = v_instant,
         last_block = GREATEST(last_block, COALESCE(NEW.ledger_block, last_block));
  RETURN NEW;
END;
$$;
CREATE TRIGGER b_clock BEFORE INSERT OR UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_clock();

-- Lines: written with their entry, in the same transaction, and never again.
CREATE FUNCTION ledger_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'ledger: journal lines are never changed or deleted';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM journal_entries
     WHERE id = NEW.entry_id
       AND txid = pg_current_xact_id()::text::bigint
  ) THEN
    RAISE EXCEPTION 'ledger: lines can only be added in the transaction that creates their entry (entry %)', NEW.entry_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER lines_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_lines_guard();

CREATE FUNCTION ledger_forbid_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger: % is append-only and cannot be truncated', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER entries_no_truncate BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_truncate();
CREATE TRIGGER lines_no_truncate BEFORE TRUNCATE ON journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_truncate();

-- At commit: the entry balances, and a posted entry touching a mirrored
-- account names its block.
CREATE FUNCTION ledger_check_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry_id bigint;
  v_entry journal_entries%ROWTYPE;
  v_line_count integer;
  v_currency char(3);
  v_difference numeric;
BEGIN
  IF TG_TABLE_NAME = 'journal_lines' THEN
    v_entry_id := NEW.entry_id;
  ELSE
    v_entry_id := NEW.id;
  END IF;
  SELECT * INTO v_entry FROM journal_entries WHERE id = v_entry_id;

  SELECT count(*) INTO v_line_count FROM journal_lines WHERE entry_id = v_entry_id;
  IF v_line_count < 2 THEN
    RAISE EXCEPTION 'ledger: entry % has % line(s); an entry needs at least two', v_entry_id, v_line_count;
  END IF;

  SELECT currency, sum(CASE side WHEN 'debit' THEN amount ELSE -amount END)
    INTO v_currency, v_difference
    FROM journal_lines
   WHERE entry_id = v_entry_id
   GROUP BY currency
  HAVING sum(CASE side WHEN 'debit' THEN amount ELSE -amount END) <> 0
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ledger: entry % is unbalanced: debits and credits differ by % minor units of %',
      v_entry_id, v_difference, v_currency;
  END IF;

  IF v_entry.status = 'posted' AND v_entry.ledger_block IS NULL AND EXISTS (
    SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id
     WHERE l.entry_id = v_entry_id AND a.mirrored
  ) THEN
    RAISE EXCEPTION 'ledger: entry % touches a mirrored account and must carry the block it settled in', v_entry_id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_entry();
CREATE CONSTRAINT TRIGGER entries_balanced AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_entry();
