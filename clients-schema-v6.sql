-- clients-schema-v6.sql — Personal message on Secure Intake Links
-- Run in Supabase SQL Editor after v5.

-- Shown to the recipient at the top of intake.html, e.g. "Hey Tamara, just
-- copy/paste this into the boxes below." Distinct from `label`, which is
-- staff-only and never shown to the recipient.
alter table intake_tokens add column if not exists message text;
