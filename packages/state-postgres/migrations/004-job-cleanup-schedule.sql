CREATE TABLE IF NOT EXISTS hub_publication_job_cleanup (
  deck_id text PRIMARY KEY,
  pending boolean NOT NULL DEFAULT false,
  last_started_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  CONSTRAINT fk_hub_publication_job_cleanup_deck FOREIGN KEY (deck_id)
    REFERENCES hub_publications (deck_id) ON DELETE RESTRICT,
  CONSTRAINT chk_hub_publication_job_cleanup_lease
    CHECK ((lease_token IS NULL AND lease_until IS NULL) OR (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_hub_publication_job_cleanup_due
  ON hub_publication_job_cleanup (last_started_at, lease_until, deck_id)
  WHERE pending OR lease_token IS NOT NULL;
