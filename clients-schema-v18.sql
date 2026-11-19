-- clients-schema-v18.sql — Costs screen: actual card charges (SimpleFIN), matched to
-- subscriptions.
-- Run in Supabase SQL Editor (project enowrzljapjkaxpsvdhr) after v17. Safe to re-run.
-- Run it BEFORE deploying the code that uses it: the Subscriptions form saves card_match.
--
-- card_charges     every transaction on the business card / checking accounts picked in
--                  SIMPLEFIN_ACCOUNT_IDS, written by /.netlify/functions/fetch-costs.
--                  amount_usd keeps SimpleFIN's sign: negative = money out.
-- charge_ignores   description patterns that are never costs (card payments, transfers),
--                  left out of the "recurring charges with no match" list.
-- subscriptions.card_match
--                  case-insensitive text found in that vendor's card charges (e.g.
--                  'Netlify'). Matching happens when the Costs screen loads, so a new
--                  or changed pattern also applies to charges already stored.
-- subscriptions.card_amount
--                  optional exact charge amount, for two products billed under one name
--                  (a $100.00 plan vs. variable API top-ups from the same vendor). Rules
--                  with an amount are tried before text-only ones.
--
-- Same access model as v14: RLS on with no policies, service_role grants only.

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS card_match text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS card_amount numeric(12,2);

CREATE TABLE IF NOT EXISTS card_charges (
  account_id    text          NOT NULL,            -- SimpleFIN account id
  txn_id        text          NOT NULL,            -- SimpleFIN transaction id (unique per account)
  account_name  text,
  posted_on     date          NOT NULL,
  amount_usd    numeric(12,2) NOT NULL,            -- negative = charge, positive = refund/credit
  description   text,
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, txn_id)
);
CREATE INDEX IF NOT EXISTS card_charges_posted_on ON card_charges (posted_on);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE card_charges TO service_role;
ALTER TABLE card_charges ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS charge_ignores (
  pattern     text        PRIMARY KEY,             -- case-insensitive text in the description
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE charge_ignores TO service_role;
ALTER TABLE charge_ignores ENABLE ROW LEVEL SECURITY;

-- Seed data (ignore patterns, card_match values, the OpenRouter and Higgsfield rows) is
-- applied through the REST API, not kept here: this repo is public.
