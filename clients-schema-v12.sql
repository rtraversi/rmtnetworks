-- clients-schema-v12.sql — Current status snapshot per client (for the command center)
-- Run in Supabase SQL Editor after v11.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS current_status    text,
  ADD COLUMN IF NOT EXISTS status_updated_at timestamptz;
