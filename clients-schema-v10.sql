-- clients-schema-v10.sql — Add "Delivered" client status
-- Run in Supabase SQL Editor after v9.
-- "Active" now means work is actively in progress; "Delivered" means the
-- project/automation was handed off (relationship may still continue —
-- support, future add-ons — but nothing is actively being built).

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_status_check;
ALTER TABLE clients ADD CONSTRAINT clients_status_check
  CHECK (status IN ('prospect','active','delivered','paused','former'));
