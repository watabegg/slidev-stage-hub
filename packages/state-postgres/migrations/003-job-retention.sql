CREATE TABLE IF NOT EXISTS hub_publication_job_tombstones (
  deck_id text NOT NULL,
  job_id uuid NOT NULL,
  PRIMARY KEY (deck_id, job_id),
  FOREIGN KEY (deck_id) REFERENCES hub_publications (deck_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS hub_publication_job_input_outbox (
  deck_id text NOT NULL,
  job_id uuid NOT NULL,
  input_key text NOT NULL,
  token uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (deck_id, input_key),
  FOREIGN KEY (deck_id) REFERENCES hub_publications (deck_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_hub_publication_job_input_outbox_order
  ON hub_publication_job_input_outbox (deck_id, created_at, input_key);

CREATE INDEX IF NOT EXISTS idx_hub_publication_jobs_parent
  ON hub_publication_jobs (deck_id, parent_job_id) WHERE parent_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hub_publication_jobs_input_key
  ON hub_publication_jobs (deck_id, input_key) WHERE input_key IS NOT NULL;
