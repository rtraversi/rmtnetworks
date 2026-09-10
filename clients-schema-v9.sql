-- clients-schema-v9.sql — Rename pipeline stages away from bid language
-- Run in Supabase SQL Editor after v8.
-- 'won' → 'hired' (no bidding process, prospects just get hired)
-- 'lost' → 'not_moving_forward'

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_pipeline_stage_check;

UPDATE clients SET pipeline_stage = 'hired'              WHERE pipeline_stage = 'won';
UPDATE clients SET pipeline_stage = 'not_moving_forward'  WHERE pipeline_stage = 'lost';

ALTER TABLE clients ADD CONSTRAINT clients_pipeline_stage_check
  CHECK (pipeline_stage IN ('new_lead','contacted','proposal_sent','hired','not_moving_forward'));
