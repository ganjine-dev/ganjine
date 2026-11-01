CREATE TABLE items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (name ~ '^[^\s/]+$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  meta jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (name ~ '^[^/]+$'),
  parent_id uuid REFERENCES categories(id),
  meta jsonb NOT NULL DEFAULT '{}',
  UNIQUE NULLS NOT DISTINCT (parent_id, name)
);

CREATE TABLE category_edges (
  from_id uuid NOT NULL REFERENCES categories(id),
  to_id uuid NOT NULL REFERENCES categories(id),
  kind text NOT NULL,
  PRIMARY KEY (from_id, to_id, kind),
  CHECK (from_id <> to_id)
);

CREATE TABLE item_categories (
  item_id uuid NOT NULL REFERENCES items(id),
  category_id uuid NOT NULL REFERENCES categories(id),
  PRIMARY KEY (item_id, category_id)
);

CREATE TABLE agents (
  name text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('asset', 'temporal', 'developer')),
  instruction_ref text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name text NOT NULL REFERENCES agents(name),
  cron text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  input jsonb NOT NULL DEFAULT '{}',
  created_by text NOT NULL
);

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name text NOT NULL REFERENCES agents(name),
  schedule_id uuid REFERENCES schedules(id),
  started_at timestamptz,
  ended_at timestamptz,
  status text NOT NULL CHECK (status IN ('scheduled', 'running', 'succeeded', 'failed', 'timed_out')),
  meta jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  item_id uuid REFERENCES items(id),
  run_id uuid REFERENCES runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  tags text[] NOT NULL DEFAULT '{}',
  payload jsonb NOT NULL DEFAULT '{}',
  blob_ref text
);
CREATE INDEX records_kind_created ON records (kind, created_at);
CREATE INDEX records_item_created ON records (item_id, created_at);
CREATE INDEX records_run ON records (run_id);
CREATE INDEX records_tags ON records USING gin (tags);

CREATE TABLE pages (
  address text PRIMARY KEY CHECK (address ~ '^/\S*$'),
  item_id uuid REFERENCES items(id),
  latest_version_id uuid
);

-- id is also the id of the page_version record, whose payload holds the same content.
CREATE TABLE page_versions (
  id uuid PRIMARY KEY REFERENCES records(id),
  address text NOT NULL REFERENCES pages(address),
  as_of date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  run_id uuid REFERENCES runs(id),
  content jsonb NOT NULL
);
CREATE INDEX page_versions_resolve ON page_versions (address, as_of DESC, created_at DESC);

ALTER TABLE pages ADD FOREIGN KEY (latest_version_id) REFERENCES page_versions(id);

CREATE TABLE run_logs (
  run_id uuid NOT NULL REFERENCES runs(id),
  ts timestamptz NOT NULL DEFAULT now(),
  level text NOT NULL,
  message text NOT NULL
);
CREATE INDEX run_logs_run ON run_logs (run_id, ts);

CREATE TABLE health (
  component text PRIMARY KEY,
  status text NOT NULL,
  checked_at timestamptz NOT NULL,
  last_ok_at timestamptz,
  last_error text
);

CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % rejected', TG_TABLE_NAME, TG_OP;
END $$;

CREATE TRIGGER records_append_only BEFORE UPDATE OR DELETE ON records
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER records_no_truncate BEFORE TRUNCATE ON records
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER page_versions_append_only BEFORE UPDATE OR DELETE ON page_versions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER page_versions_no_truncate BEFORE TRUNCATE ON page_versions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER run_logs_append_only BEFORE UPDATE OR DELETE ON run_logs
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER run_logs_no_truncate BEFORE TRUNCATE ON run_logs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
