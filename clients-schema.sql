-- Clients module: contact card + per-client Docker containers + per-client logins.
-- Run once in the Supabase SQL editor.

create extension if not exists "pgcrypto";

create table if not exists clients (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  company     text,
  email       text,
  phone       text,
  address     text,
  website     text,
  status      text not null default 'active' check (status in ('active','paused','former')),
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists client_containers (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id) on delete cascade,
  name        text not null,
  image       text,
  port        integer,
  host        text,
  url         text,
  notes       text,
  created_at  timestamptz not null default now()
);

-- Passwords are stored as AES-256-GCM ciphertext: "iv_hex:ciphertext_hex:authtag_hex".
-- Encryption/decryption happens in /.netlify/functions/logins using SECRETS_KEY.
create table if not exists client_logins (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references clients(id) on delete cascade,
  app                 text not null,
  username            text,
  password_encrypted  text,
  url                 text,
  notes               text,
  created_at          timestamptz not null default now()
);

create index if not exists idx_client_containers_client on client_containers(client_id);
create index if not exists idx_client_logins_client     on client_logins(client_id);
