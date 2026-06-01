-- clients-schema-v2.sql — CRM + Support Contracts migration
-- Run in Supabase SQL Editor

-- 1. CRM fields on clients
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS date_hired              date,
  ADD COLUMN IF NOT EXISTS contracted_monthly_rate numeric(10,2),
  ADD COLUMN IF NOT EXISTS contract_billing_cycle  text DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS contract_renewal_date   date,
  ADD COLUMN IF NOT EXISTS scope_of_work           text,
  ADD COLUMN IF NOT EXISTS payment_terms           text,
  ADD COLUMN IF NOT EXISTS contract_url            text,
  ADD COLUMN IF NOT EXISTS next_followup_date      date,
  ADD COLUMN IF NOT EXISTS stripe_customer_email   text;

-- 2. Category on logins (for grouping)
ALTER TABLE client_logins
  ADD COLUMN IF NOT EXISTS category text;

-- 3. Support contracts
CREATE TABLE IF NOT EXISTS client_support_contracts (
  id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid         NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  purchased_date   date         NOT NULL DEFAULT CURRENT_DATE,
  hours_purchased  numeric(6,2) NOT NULL DEFAULT 10,
  rate_per_hour    numeric(8,2) NOT NULL DEFAULT 100.00,
  hours_used       numeric(6,2) NOT NULL DEFAULT 0 CHECK (hours_used >= 0),
  notes            text,
  created_at       timestamptz  DEFAULT now()
);

ALTER TABLE client_support_contracts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anon full access" ON client_support_contracts;
CREATE POLICY "Anon full access" ON client_support_contracts
  FOR ALL USING (true) WITH CHECK (true);
