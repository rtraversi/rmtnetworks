#!/usr/bin/env node
// Manage portal accounts (Supabase Auth) for Rob / Katy / Max.
//
//   node scripts/portal-user.js list
//   node scripts/portal-user.js add <email> <Rob|Katy|Max>   create + print a setup link
//   node scripts/portal-user.js link <email>                 new setup / reset link
//   node scripts/portal-user.js reset-mfa <email>            remove authenticator (lost phone)
//   node scripts/portal-user.js signout <email>              print SQL that revokes all sessions
//   node scripts/portal-user.js remove <email>               delete the account
//
// A setup link signs the person in once; the login page then has them enroll
// an authenticator app and choose their own password. Links expire (Auth
// setting "Email OTP expiration", default 1 hour), so send it promptly.
// Generating a link does not send an email; you pass it on yourself.
//
// Needs the project's secret key (Dashboard > Project Settings > API Keys,
// sb_secret_...). Put it in C:\Sites\rmtnetworks\.env as
//   SUPABASE_SECRET_KEY=sb_secret_...
// or set it in the environment. Never commit it.
'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_URL = 'https://enowrzljapjkaxpsvdhr.supabase.co';
const SITE = 'https://rmtnetworks.com/';
const USERS = ['Rob', 'Katy', 'Max'];

function envFromFile() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const fileEnv = envFromFile();
const KEY = process.env.SUPABASE_SECRET_KEY || fileEnv.SUPABASE_SECRET_KEY;
const BASE = (process.env.SUPABASE_URL || PROJECT_URL).replace(/\/+$/, '') + '/auth/v1';

async function api(method, p, body) {
  const headers = { apikey: KEY, 'Content-Type': 'application/json' };
  if (KEY.startsWith('eyJ')) headers.Authorization = 'Bearer ' + KEY; // legacy service_role JWT
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${p} -> HTTP ${res.status}: ${(data && (data.msg || data.message || data.error_description || data.error)) || text}`);
  return data;
}

async function allUsers() {
  const out = [];
  for (let page = 1; ; page++) {
    const d = await api('GET', `/admin/users?page=${page}&per_page=200`);
    out.push(...d.users);
    if (d.users.length < 200) return out;
  }
}

async function findUser(email) {
  const u = (await allUsers()).find((x) => (x.email || '').toLowerCase() === email.toLowerCase());
  if (!u) throw new Error('No user with email ' + email);
  return u;
}

// The user list endpoint does not include MFA factors; this one does.
async function factorsOf(u) {
  const d = await api('GET', `/admin/users/${u.id}/factors`);
  return Array.isArray(d) ? d : (d && d.factors) || [];
}

async function setupLink(email) {
  const d = await api('POST', '/admin/generate_link', { type: 'recovery', email, redirect_to: SITE });
  return d.action_link || (d.properties && d.properties.action_link);
}

async function main() {
  const [cmd, email, who] = process.argv.slice(2);
  if (!KEY) throw new Error('SUPABASE_SECRET_KEY is not set (see the header of this script).');

  switch (cmd) {
    case 'list': {
      for (const u of await allUsers()) {
        const factors = (await factorsOf(u)).filter((f) => f.status === 'verified').length;
        console.log([u.email, (u.app_metadata || {}).portal_user || '(no portal access)',
          factors ? 'MFA on' : 'MFA not set up', 'last sign-in ' + (u.last_sign_in_at || 'never')].join('  |  '));
      }
      return;
    }
    case 'add': {
      if (!email || !USERS.includes(who)) throw new Error('usage: add <email> <Rob|Katy|Max>');
      const taken = (await allUsers()).find((u) => (u.app_metadata || {}).portal_user === who);
      if (taken) throw new Error(`${who} is already assigned to ${taken.email}`);
      await api('POST', '/admin/users', { email, email_confirm: true, app_metadata: { portal_user: who } });
      console.log(`Created ${email} as ${who}. One-time setup link:\n\n${await setupLink(email)}\n`);
      return;
    }
    case 'link': {
      await findUser(email);
      console.log(`One-time setup/reset link for ${email}:\n\n${await setupLink(email)}\n`);
      return;
    }
    case 'reset-mfa': {
      const u = await findUser(email);
      const fs_ = await factorsOf(u);
      for (const f of fs_) await api('DELETE', `/admin/users/${u.id}/factors/${f.id}`);
      const left = (await factorsOf(u)).length;
      if (left) throw new Error(`${left} factor(s) still on ${email} after delete`);
      console.log(`Removed ${fs_.length} factor(s) from ${email}. They will enroll a new authenticator at next sign-in.`);
      console.log('Existing sessions stay valid until they expire; run "signout" too if the device was lost.');
      return;
    }
    case 'signout': {
      // No admin REST endpoint revokes another user's sessions; deleting their
      // auth.sessions rows does (refresh tokens go with them). Run in the
      // Supabase SQL editor:
      const u = await findUser(email);
      console.log(`delete from auth.sessions where user_id = '${u.id}';`);
      console.log('Access tokens already issued still expire on their own (1 hour by default).');
      return;
    }
    case 'remove': {
      const u = await findUser(email);
      await api('DELETE', `/admin/users/${u.id}`);
      console.log(`Deleted ${email}. Access tokens already issued expire within the hour.`);
      return;
    }
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 9).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
