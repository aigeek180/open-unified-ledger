-- The console lists a participant's instructions newest first (SPEC.md §4.6).
CREATE INDEX instructions_created_idx ON instructions (created_at DESC, uetr DESC);
