CREATE TABLE ledger (
  seq bigint PRIMARY KEY CHECK (seq > 0),
  record_id uuid NOT NULL UNIQUE REFERENCES records(id),
  prev_hash text NOT NULL,
  entry_hash text NOT NULL,
  signature text NOT NULL
);

CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON ledger
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
