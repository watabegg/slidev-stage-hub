CREATE TABLE IF NOT EXISTS hub_publication_jobs (
  deck_id text NOT NULL,
  job_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('publication', 'thumbnail')),
  parent_job_id uuid,
  request_hash text NOT NULL,
  input_key text,
  input_hash text,
  target_revision text,
  generation bigint CHECK (generation IS NULL OR generation >= 1),
  runtime_id text,
  profile_digest text NOT NULL,
  compiler_contract_version text NOT NULL,
  thumbnail_mode text NOT NULL CHECK (thumbnail_mode IN ('auto', 'none')),
  view_token_hash text NOT NULL,
  view_expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'retry_wait', 'succeeded', 'partial', 'failed', 'superseded')),
  phase text NOT NULL CHECK (phase IN ('runtime', 'compile', 'store', 'publish', 'thumbnail')),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_run_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  progress jsonb,
  stages jsonb NOT NULL,
  result jsonb,
  error jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  prepared_manifest jsonb,
  prepared_cached boolean,
  CONSTRAINT pk_hub_publication_jobs PRIMARY KEY (deck_id, job_id),
  CONSTRAINT fk_hub_publication_jobs_deck FOREIGN KEY (deck_id)
    REFERENCES hub_publications (deck_id) ON DELETE RESTRICT,
  CONSTRAINT fk_hub_publication_jobs_parent FOREIGN KEY (deck_id, parent_job_id)
    REFERENCES hub_publication_jobs (deck_id, job_id) ON DELETE RESTRICT,
  CONSTRAINT chk_hub_publication_jobs_lease
    CHECK ((lease_token IS NULL AND lease_until IS NULL) OR (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_hub_publication_jobs_ready
  ON hub_publication_jobs (status, next_run_at, lease_until, created_at, job_id);

CREATE INDEX IF NOT EXISTS idx_hub_publication_jobs_deck_history
  ON hub_publication_jobs (deck_id, created_at DESC, job_id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_publication_jobs_active_child
  ON hub_publication_jobs (deck_id, parent_job_id, kind)
  WHERE parent_job_id IS NOT NULL AND status IN ('queued', 'running', 'retry_wait');
