-- Client custody (SPEC.md §15): the omnibus wallets a custodian has held its
-- clients' bonds at, by generation. One is active; a recovery adds the next
-- as pending, and once the chain shows the units moved, the old one is lost.
CREATE TABLE custody_wallets (
  address     text PRIMARY KEY CHECK (address ~ '^0x[0-9a-f]{40}$'),
  generation  integer NOT NULL UNIQUE CHECK (generation > 0),
  status      text NOT NULL CHECK (status IN ('active', 'pending', 'lost')),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX custody_wallets_one_active ON custody_wallets (status) WHERE status = 'active';
