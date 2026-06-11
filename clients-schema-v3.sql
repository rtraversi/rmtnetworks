-- clients-schema-v3.sql — Per-client service integrations
-- Run in Supabase SQL Editor after v2.

-- Stores encrypted API credentials for third-party services per client.
-- Credentials are AES-256-GCM ciphertext (same scheme as client_logins.password_encrypted).
-- One row per credential key, e.g. service='twilio', key_name='account_sid'
CREATE TABLE IF NOT EXISTS client_integrations (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service          text        NOT NULL,  -- e.g. 'twilio', 'sendgrid'
  key_name         text        NOT NULL,  -- e.g. 'account_sid', 'auth_token', 'api_key'
  value_encrypted  text,                  -- AES-256-GCM: iv_hex:ciphertext_hex:authtag_hex
  enabled          boolean     NOT NULL DEFAULT true,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, service, key_name)
);

CREATE INDEX IF NOT EXISTS idx_client_integrations_client  ON client_integrations(client_id);
CREATE INDEX IF NOT EXISTS idx_client_integrations_service ON client_integrations(client_id, service);

ALTER TABLE client_integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anon full access" ON client_integrations;
CREATE POLICY "Anon full access" ON client_integrations
  FOR ALL USING (true) WITH CHECK (true);
