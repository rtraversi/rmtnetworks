-- clients-schema-v11.sql — Add "BSBR" client status (personal projects)
-- Run in Supabase SQL Editor after v10.

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_status_check;
ALTER TABLE clients ADD CONSTRAINT clients_status_check
  CHECK (status IN ('prospect','active','delivered','paused','former','bsbr'));
