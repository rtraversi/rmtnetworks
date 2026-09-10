-- clients-schema-v8.sql — Client Payment Ledger
-- Run in Supabase SQL Editor after v7.
-- Replaces the abandoned v4 "monthly billing ledger" concept (cost/margin
-- tracking) with a plain log of what's owed (charges) and what's been
-- received (payments) from the client. Balance due = charges - payments,
-- which naturally covers deposit-then-balance-on-delivery terms (log the
-- deposit as one payment, the rest as another) and scope add-ons (log an
-- extra charge line, e.g. "Automation add-on — $250").

-- Amounts owed: the original project/engagement price, plus any add-ons.
CREATE TABLE IF NOT EXISTS client_charges (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid          NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  charged_on  date          NOT NULL,
  description text          NOT NULL,
  amount      numeric(10,2) NOT NULL,
  created_at  timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_charges_client ON client_charges(client_id, charged_on DESC);

ALTER TABLE client_charges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anon full access" ON client_charges;
CREATE POLICY "Anon full access" ON client_charges FOR ALL USING (true) WITH CHECK (true);

-- Amounts received.
CREATE TABLE IF NOT EXISTS client_payments (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid          NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  paid_on     date          NOT NULL,
  amount      numeric(10,2) NOT NULL,
  method      text,  -- 'check', 'ach', 'card', 'cash', 'other'
  note        text,
  created_at  timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_payments_client ON client_payments(client_id, paid_on DESC);

ALTER TABLE client_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anon full access" ON client_payments;
CREATE POLICY "Anon full access" ON client_payments FOR ALL USING (true) WITH CHECK (true);
