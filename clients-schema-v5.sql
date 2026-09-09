-- clients-schema-v5.sql — Secure Intake Links
-- Run in Supabase SQL Editor after v4.

create extension if not exists "pgcrypto";

-- Prospects are tracked the same as clients, just with a different status —
-- this is what lets an intake link create a row before anyone's "hired."
alter table clients drop constraint if exists clients_status_check;
alter table clients add constraint clients_status_check
  check (status in ('prospect','active','paused','former'));

-- One row per generated link. The token itself is the bearer credential —
-- treat it like a password: only ever handled server-side, never logged.
create table if not exists intake_tokens (
  id            uuid        primary key default gen_random_uuid(),
  client_id     uuid        references clients(id) on delete cascade,   -- null = brand-new prospect, created on submit
  prospect_name text,                                                   -- shown to staff before the prospect has a client row
  token         text        not null unique,                            -- random, URL-safe, generated server-side
  label         text,                                                   -- optional internal note, e.g. "Onboarding — Sept"
  fields        jsonb       not null default '["contact"]'::jsonb,      -- which sections to show: contact | logins | subscriptions | notes
  expires_at    timestamptz not null,
  max_uses      integer     not null default 1,
  use_count     integer     not null default 0,
  created_by    text,                                                   -- 'Rob' | 'Katy' | 'Max'
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz
);

create index if not exists idx_intake_tokens_client on intake_tokens(client_id);

alter table intake_tokens enable row level security;
drop policy if exists "Anon full access" on intake_tokens;
create policy "Anon full access" on intake_tokens for all using (true) with check (true);

-- What a prospect/client actually typed in. Password-shaped fields inside
-- `data` are pre-encrypted (same AES-256-GCM scheme as client_logins) before
-- this row is ever written — see intake.js.
create table if not exists intake_submissions (
  id                 uuid        primary key default gen_random_uuid(),
  token_id           uuid        not null references intake_tokens(id) on delete cascade,
  client_id          uuid        references clients(id) on delete cascade,
  submitted_by_name  text,
  submitted_by_email text,
  data               jsonb       not null,
  status             text        not null default 'pending' check (status in ('pending','applied','dismissed')),
  applied_at         timestamptz,
  applied_by         text,
  created_at         timestamptz not null default now()
);

create index if not exists idx_intake_submissions_token  on intake_submissions(token_id);
create index if not exists idx_intake_submissions_client on intake_submissions(client_id);
create index if not exists idx_intake_submissions_status on intake_submissions(status);

alter table intake_submissions enable row level security;
drop policy if exists "Anon full access" on intake_submissions;
create policy "Anon full access" on intake_submissions for all using (true) with check (true);
