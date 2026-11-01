ALTER TABLE schedules
  ADD COLUMN next_run_at timestamptz NOT NULL,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX schedules_due ON schedules (next_run_at) WHERE enabled;

ALTER TABLE runs
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX runs_created ON runs (created_at DESC);
CREATE INDEX runs_status ON runs (status);
