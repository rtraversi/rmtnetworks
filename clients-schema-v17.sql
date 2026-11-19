-- clients-schema-v17.sql — Costs screen: daily spend per usage-billed service, plus
-- the latest fetch result for each one.
-- Run in Supabase SQL Editor (project enowrzljapjkaxpsvdhr) after v16. Safe to re-run.
--
-- cost_daily   one row per service, scope and UTC day. Written by
--              /.netlify/functions/fetch-costs (called twice a day by
--              .github/workflows/usage-cron.yml), which re-upserts the last ~31 days
--              on every run, so late-arriving vendor data overwrites earlier figures.
--              scope splits a service where the vendor can (for Anthropic, the
--              workspace id); '' means the whole account.
-- cost_status  one row per service: when it was last fetched, whether that worked,
--              and any balance the vendor reports (e.g. prepaid credits left).
--
-- Fixed-price plans are not copied here; the Costs screen reads them from
-- subscriptions. Same access model as v14: RLS on with no policies, service_role
-- grants only, every read/write goes through a Netlify function with the secret key.

CREATE TABLE IF NOT EXISTS cost_daily (
  service      text          NOT NULL,              -- 'anthropic', 'openrouter'
  scope        text          NOT NULL DEFAULT '',   -- workspace id / key id, '' = whole account
  day          date          NOT NULL,              -- UTC day
  amount_usd   numeric(12,4) NOT NULL DEFAULT 0,
  requests     integer,
  updated_at   timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (service, scope, day)
);
CREATE INDEX IF NOT EXISTS cost_daily_day ON cost_daily (day);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE cost_daily TO service_role;
ALTER TABLE cost_daily ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS cost_status (
  service      text          PRIMARY KEY,
  ok           boolean       NOT NULL,
  error        text,                                -- last error message when ok = false
  balance_usd  numeric(12,4),                       -- prepaid balance left, where the vendor has one
  details      jsonb         NOT NULL DEFAULT '{}', -- e.g. { "scopes": { "<workspace id>": "<name>" } }
  checked_at   timestamptz   NOT NULL DEFAULT now(),
  last_ok_at   timestamptz
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE cost_status TO service_role;
ALTER TABLE cost_status ENABLE ROW LEVEL SECURITY;
