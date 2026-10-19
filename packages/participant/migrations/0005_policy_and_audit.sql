-- Approval policies and the audit log (SPEC.md §15, invariant 12).

-- An instruction an operator started that waits, booked but unsigned and
-- unsent, until its participant's policy is met; or one an approver refused.
ALTER TABLE instructions DROP CONSTRAINT instructions_status_check;
ALTER TABLE instructions ADD CONSTRAINT instructions_status_check
  CHECK (status IN ('proposed', 'ready', 'submitted', 'awaiting', 'settled', 'failed', 'expired', 'rejected'));
DROP INDEX instructions_open_idx;
CREATE INDEX instructions_open_idx ON instructions (status, deadline)
  WHERE status IN ('proposed', 'ready', 'submitted', 'awaiting');

-- What an operator started and its policy asks of it: an instruction, a
-- buyer's affirmation, or an administrative change, keyed by its subject (a
-- UETR or a change's id). `required` approvals from operators holding one of
-- `roles`, other than the initiator, before it goes on.
CREATE TABLE proposals (
  subject     text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('instruction', 'affirmation', 'change')),
  action      text NOT NULL,
  initiator   text NOT NULL,
  rule        integer,
  required    integer NOT NULL CHECK (required >= 0),
  roles       jsonb NOT NULL,
  status      text NOT NULL CHECK (status IN ('open', 'approved', 'rejected', 'expired')),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at  timestamptz
);
CREATE INDEX proposals_open_idx ON proposals (created_at) WHERE status = 'open';

-- Each operator's decision on a proposal: one per operator.
CREATE TABLE proposal_decisions (
  subject   text NOT NULL REFERENCES proposals (subject),
  operator  text NOT NULL,
  decision  text NOT NULL CHECK (decision IN ('approve', 'reject')),
  roles     jsonb NOT NULL,
  at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (subject, operator)
);

-- An affirmation counts only once its policy is met.
ALTER TABLE affirmations ADD COLUMN status text NOT NULL DEFAULT 'affirmed'
  CHECK (status IN ('proposed', 'affirmed', 'rejected', 'expired'));

-- Every initiation, approval, rejection, signature and submission, and each
-- outcome, in order. Each entry carries the hash of the one before it, so an
-- edited or deleted entry breaks the chain at that point (audit.ts verifies
-- it). The rules below make the log append-only for the runtime; someone who
-- goes around them is still caught by the chain.
CREATE TABLE audit_log (
  seq      bigint PRIMARY KEY CHECK (seq > 0),
  at       timestamptz NOT NULL,
  actor    text NOT NULL,
  action   text NOT NULL,
  subject  text,
  detail   jsonb NOT NULL,
  prev     text NOT NULL CHECK (prev ~ '^[0-9a-f]{64}$'),
  hash     text NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX audit_log_subject_idx ON audit_log (subject);

CREATE FUNCTION audit_log_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit: the log is append-only (%)', TG_OP;
END;
$$;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_guard();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_guard();
