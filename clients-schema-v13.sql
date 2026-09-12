-- clients-schema-v13.sql — Structured handoff detail per client (Command Center drill-down)
-- Run in Supabase SQL Editor after v12.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS status_detail jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Shape (all optional, all freeform text, merged in-place by crm-log.ps1):
-- {
--   "last_handoff":      "Where we stopped last session",
--   "next_up":           "What's next on the list",
--   "waiting_on":        "Missing info / things we're waiting on from the client",
--   "sent_pending":      "Things sent to the client, awaiting their response",
--   "client_questions":  "Open questions the client asked that we still owe an answer to"
-- }
