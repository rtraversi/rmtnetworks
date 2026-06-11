-- clients-schema-v4.sql — Monthly billing ledger
-- Run in Supabase SQL Editor after v3.

-- One record per client per calendar month. Tracks review status.
CREATE TABLE IF NOT EXISTS client_billing_months (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  month        date        NOT NULL,  -- always the 1st of the month, e.g. 2026-06-01
  status       text        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','reviewed','invoiced','paid')),
  notes        text,
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, month)
);

CREATE INDEX IF NOT EXISTS idx_billing_months_client ON client_billing_months(client_id);

ALTER TABLE client_billing_months ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anon full access" ON client_billing_months;
CREATE POLICY "Anon full access" ON client_billing_months FOR ALL USING (true) WITH CHECK (true);

-- One-off charge or credit entries attached to a billing month.
-- Positive amount = extra charge to client. Negative = credit.
CREATE TABLE IF NOT EXISTS client_billing_adjustments (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_month_id uuid        NOT NULL REFERENCES client_billing_months(id) ON DELETE CASCADE,
  description      text        NOT NULL,
  amount           numeric(10,2) NOT NULL,
  category         text,  -- 'addon', 'credit', 'overage', 'one-time', etc.
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_adj_month ON client_billing_adjustments(billing_month_id);

ALTER TABLE client_billing_adjustments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anon full access" ON client_billing_adjustments;
CREATE POLICY "Anon full access" ON client_billing_adjustments FOR ALL USING (true) WITH CHECK (true);
