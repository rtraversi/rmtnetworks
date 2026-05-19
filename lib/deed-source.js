// /lib/deed-source.js
//
// Adapter for fetching "new deed" records.
//
// Two backends:
//   - 'supabase' (default for demo): reads the demo_new_deeds table
//   - 'static'  : reads /demos/new-deed/seed.json from disk (fallback for local dev)
//   - 'vault'   : production placeholder — calls VAULT_API_URL with VAULT_API_KEY
//
// Select backend via env var DEED_SOURCE. Production swap is one env-var change.
//
// Public interface (stable across backends — DO NOT change shape):
//   listDeeds()  -> Promise<Array<DeedRecord>>
//   getDeed(id)  -> Promise<DeedRecord | null>
//
// DeedRecord shape — see /db/new-deed-schema.sql and /demos/new-deed/seed.json.

const fs = require('fs');
const path = require('path');

const SOURCE = (process.env.DEED_SOURCE || 'supabase').toLowerCase();

// ---------------------------------------------------------------------------
// Supabase backend (demo default)
// ---------------------------------------------------------------------------
async function listSupabase() {
  const url = `${process.env.SUPABASE_URL}/rest/v1/demo_new_deeds?select=*&order=label.asc`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase list failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getSupabase(id) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/demo_new_deeds?id=eq.${encodeURIComponent(id)}&select=*`;
  const res = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase get failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Static JSON backend (offline / fallback)
// ---------------------------------------------------------------------------
function loadStaticSeed() {
  const p = path.join(__dirname, '..', 'demos', 'new-deed', 'seed.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')).deeds;
}

async function listStatic() {
  return loadStaticSeed();
}

async function getStatic(id) {
  return loadStaticSeed().find(d => d.id === id) || null;
}

// ---------------------------------------------------------------------------
// Vault backend (production placeholder)
//
// Implement when the attorney provides her vault endpoint + auth.
// Expected to return DeedRecord-shaped objects.
// ---------------------------------------------------------------------------
async function listVault() {
  const res = await fetch(`${process.env.VAULT_API_URL}/deeds`, {
    headers: { Authorization: `Bearer ${process.env.VAULT_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Vault list failed: ${res.status}`);
  return res.json();
}

async function getVault(id) {
  const res = await fetch(`${process.env.VAULT_API_URL}/deeds/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${process.env.VAULT_API_KEY}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Vault get failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
const BACKENDS = {
  supabase: { list: listSupabase, get: getSupabase },
  static:   { list: listStatic,   get: getStatic   },
  vault:    { list: listVault,    get: getVault    },
};

function backend() {
  const b = BACKENDS[SOURCE];
  if (!b) throw new Error(`Unknown DEED_SOURCE: ${SOURCE}`);
  return b;
}

module.exports = {
  listDeeds: () => backend().list(),
  getDeed:   (id) => backend().get(id),
  currentSource: () => SOURCE,
};
