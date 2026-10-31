-- clients-schema-v15.sql — Backups tile: which client sites are backed up, and how each run went
-- Run in Supabase SQL Editor (project enowrzljapjkaxpsvdhr) after v14.
--
-- backup_sites  one row per monitored site. Each site's nightly backup job
--               authenticates with its own token; only the SHA-256 is stored.
-- backup_runs   one row per backup run, POSTed by the job to
--               /.netlify/functions/backup-report at the end of every run.
--
-- Same access model as v14: RLS on with no policies, service_role grants only,
-- every read/write goes through a Netlify function with the secret key.

CREATE TABLE IF NOT EXISTS backup_sites (
  slug              text PRIMARY KEY,                 -- e.g. 'scrogginssavage'
  label             text NOT NULL,                    -- shown on the tile
  token_sha256      text NOT NULL UNIQUE,             -- hex SHA-256 of the site's report token
  expected_hours    integer NOT NULL DEFAULT 26,      -- red if no run within this many hours
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE backup_sites TO service_role;
ALTER TABLE backup_sites ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS backup_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site              text NOT NULL REFERENCES backup_sites(slug) ON DELETE CASCADE,
  status            text NOT NULL CHECK (status IN ('pass', 'fail')),
  ran_at            timestamptz NOT NULL DEFAULT now(),
  run_url           text,
  db_status         text,          -- per-job results: success / failure / cancelled / skipped
  files_status      text,
  db_bytes          bigint,        -- encrypted dump size
  restore_tables    integer,       -- tables checked by the restore test
  restore_rows      bigint,        -- rows restored and matched
  files_count       integer,       -- documents in the source bucket
  files_copied      integer,       -- new/changed documents copied this run
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backup_runs_site_ran_at ON backup_runs (site, ran_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE backup_runs TO service_role;
ALTER TABLE backup_runs ENABLE ROW LEVEL SECURITY;

-- First site: Scroggins & Savage. The token itself is set as the GitHub secret
-- RMT_BACKUP_REPORT_TOKEN on rtraversi/scrogginssavage; the value below
-- is its hex SHA-256 (the hash is not secret; the token is).
INSERT INTO backup_sites (slug, label, token_sha256)
VALUES ('scrogginssavage', 'Scroggins & Savage', 'd03cafe661283d32d8b4a2f3de2ae7feb51cade5d0ef9fb909043a6a5dbe2b5b')
ON CONFLICT (slug) DO NOTHING;
