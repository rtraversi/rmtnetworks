-- clients-schema-v16.sql — Backups tile: add Iurix as a monitored site
-- Run in Supabase SQL Editor (project enowrzljapjkaxpsvdhr) after v15.
-- ALREADY APPLIED in prod on 2026-11-02 (row inserted through the REST API);
-- this file records it so a rebuild from these files recreates it. Safe to re-run.
--
-- The token itself is the GitHub secret RMT_BACKUP_REPORT_TOKEN on
-- rtraversi/bsbr-attytraining; the value below is its hex SHA-256 (the hash is
-- not secret; the token is). The site's job: .github/workflows/backup.yml in
-- that repo, nightly 07:30 UTC; runbook in its BACKUPS.md.

INSERT INTO backup_sites (slug, label, token_sha256)
VALUES ('iurix', 'Iurix', 'c38bf4b376b10cb6391f968d4cebe335dd5871b32bc114c5866d607403b5113d')
ON CONFLICT (slug) DO NOTHING;
