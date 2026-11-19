// fetch-costs.js — pulls daily spend from usage-billed vendors into Supabase for the
// Costs screen. Called by GitHub Actions twice a day (.github/workflows/usage-cron.yml).
//
// POST/GET  Authorization: Bearer <CRON_SECRET>
//
// Each run re-fetches the last 31 UTC days and upserts them into cost_daily, so
// figures that arrive late (Anthropic lags 4-24h) overwrite earlier partial ones.
// Each service's outcome goes to cost_status, so the screen can show a broken feed
// instead of a silent $0.
//
//   anthropic   Usage and Cost Analytics API (beta), the client pay-as-you-go org.
//               One scope per workspace; null workspace = the Default workspace.
//               Env: ANTHROPIC_ADMIN_KEY (sk-ant-admin01-..., org admin key).
//   openrouter  /api/v1/activity (last 30 days, by model) and /api/v1/credits.
//               Env: OPENROUTER_MANAGEMENT_KEY (read-only management key).
//   card        SimpleFIN Bridge: every transaction on the accounts in
//               SIMPLEFIN_ACCOUNT_IDS (comma-separated SimpleFIN account ids), into
//               card_charges. Last 45 days per run; ?days=90 backfills once.
//               Env: SIMPLEFIN_ACCESS_URL (claimed access URL, holds credentials).
//
// Required env: CRON_SECRET, SUPABASE_URL, SUPABASE_KEY.

'use strict';

const DAY = 86_400_000;
const WINDOW_DAYS = 31; // the Anthropic cost API's maximum span per request

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body, null, 2),
});

const round4 = (n) => Math.round(n * 10000) / 10000;

// ── Anthropic ───────────────────────────────────────────────────────────────
const ANTHROPIC = 'https://api.anthropic.com/v1/organizations';

async function anthropicGet(key, path, params) {
  const res = await fetch(`${ANTHROPIC}${path}?${params}`, {
    headers: {
      'x-api-key': key,
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'analytics-usage-cost-2026-08-24',
    },
  });
  if (!res.ok) throw new Error(`Anthropic ${path} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function anthropicList(key, path) {
  const out = [];
  let after;
  for (let i = 0; i < 20; i++) {
    const p = new URLSearchParams({ limit: '100' });
    if (after) p.set('after_id', after);
    const r = await anthropicGet(key, path, p);
    out.push(...(r.data ?? []));
    if (!r.has_more || !r.last_id) break;
    after = r.last_id;
  }
  return out;
}

// Sums cost rows into { 'scope\u0000YYYY-MM-DD': { cents, requests } }. Exported for tests.
function sumAnthropicRows(rows) {
  const acc = new Map();
  for (const row of rows) {
    const scope = row.group?.workspace_id ?? 'default';
    const day = String(row.starting_at).slice(0, 10);
    const k = `${scope}\u0000${day}`;
    const t = acc.get(k) ?? { cents: 0, requests: 0 };
    t.cents += Number(row.cost?.amount ?? 0);
    t.requests += Number(row.cost?.requests ?? 0);
    acc.set(k, t);
  }
  return [...acc.entries()].map(([k, t]) => {
    const [scope, day] = k.split('\u0000');
    return { service: 'anthropic', scope, day, amount_usd: round4(t.cents / 100), requests: t.requests };
  });
}

async function fetchAnthropic(key, now) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = new Date(today - (WINDOW_DAYS - 1) * DAY).toISOString();
  const end = new Date(today + DAY).toISOString(); // includes today's partial bucket
  const rows = [];
  let refreshed = null;
  let page;
  for (let i = 0; i < 20; i++) {
    const p = new URLSearchParams({ starting_at: start, ending_at: end, time_bucket_width: '1d', limit: '1000' });
    p.append('group_by[]', 'workspace_id');
    if (page) p.set('page', page);
    const r = await anthropicGet(key, '/analytics/cost', p);
    rows.push(...(r.data ?? []));
    if (r.data_refreshed_at) refreshed = r.data_refreshed_at;
    if (!r.has_more || !r.next_page) break;
    page = r.next_page;
  }
  const workspaces = await anthropicList(key, '/workspaces');
  const scopes = { default: 'Default workspace' };
  for (const w of workspaces) scopes[w.id] = w.name;
  return {
    rows: sumAnthropicRows(rows),
    status: { balance_usd: null, details: { scopes, data_refreshed_at: refreshed } },
  };
}

// ── OpenRouter ──────────────────────────────────────────────────────────────
async function openrouterGet(key, path) {
  const res = await fetch(`https://openrouter.ai/api/v1${path}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`OpenRouter ${path} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Activity rows are per model per day; sum them per day. Exported for tests.
function sumOpenRouterActivity(rows) {
  const acc = new Map();
  for (const a of rows) {
    const day = String(a.date).slice(0, 10);
    const t = acc.get(day) ?? { usd: 0, requests: 0 };
    t.usd += Number(a.usage ?? 0);
    t.requests += Number(a.requests ?? 0);
    acc.set(day, t);
  }
  return [...acc.entries()].map(([day, t]) => (
    { service: 'openrouter', scope: '', day, amount_usd: round4(t.usd), requests: t.requests }
  ));
}

async function fetchOpenRouter(key) {
  const [activity, credits] = await Promise.all([openrouterGet(key, '/activity'), openrouterGet(key, '/credits')]);
  const c = credits.data ?? {};
  const total = Number(c.total_credits ?? 0);
  const used = Number(c.total_usage ?? 0);
  return {
    rows: sumOpenRouterActivity(activity.data ?? []),
    status: { balance_usd: round4(total - used), details: { total_credits: total, total_usage: round4(used) } },
  };
}

// ── Card charges (SimpleFIN Bridge) ─────────────────────────────────────────
// Same rules as the adapter in katychavez-portal-new (functions/api/_adapters/bank-feed/
// simplefin.js): only simplefin.org hosts, credentials split out of the access URL, at
// most 45 days per /accounts request, at most 24 requests a day (this runs twice a day).
const SIMPLEFIN_MAX_DAYS = 45;

function splitAccessUrl(accessUrl) {
  const url = new URL(String(accessUrl).trim());
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !(host === 'simplefin.org' || host.endsWith('.simplefin.org')) || !url.username) {
    throw new Error('SIMPLEFIN_ACCESS_URL is not an https simplefin.org access URL with credentials');
  }
  const auth = 'Basic ' + Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64');
  url.username = '';
  url.password = '';
  return { base: url.toString().replace(/\/+$/, ''), auth };
}

// One SimpleFIN account set → card_charges rows for the wanted accounts. Pending
// transactions are skipped; they come back posted. Exported for tests.
function cardRows(set, wanted) {
  const out = [];
  for (const a of set.accounts ?? []) {
    if (!wanted.has(String(a.id))) continue;
    for (const t of a.transactions ?? []) {
      const amount = Number(t.amount);
      if (t.pending || !t.posted || !Number.isFinite(amount)) continue;
      out.push({
        account_id: String(a.id),
        txn_id: String(t.id),
        account_name: a.name ?? null,
        posted_on: new Date(Number(t.posted) * 1000).toISOString().slice(0, 10),
        amount_usd: Math.round(amount * 100) / 100,
        description: String(t.payee || t.description || '').trim().slice(0, 300) || null,
      });
    }
  }
  return out;
}

async function fetchCard(accessUrl, accountIds, days, now) {
  const wanted = new Set(String(accountIds || '').split(',').map((s) => s.trim()).filter(Boolean));
  if (!wanted.size) throw new Error('SIMPLEFIN_ACCOUNT_IDS env var not set');
  const { base, auth } = splitAccessUrl(accessUrl);
  const end = Math.floor(now.getTime() / 1000);
  const rows = [];
  const warnings = new Set();
  // Oldest window first; each at most 45 days.
  for (let start = end - days * 86400; start < end; start += SIMPLEFIN_MAX_DAYS * 86400) {
    const winEnd = Math.min(start + SIMPLEFIN_MAX_DAYS * 86400, end);
    const p = new URLSearchParams({ 'start-date': String(start), 'end-date': String(winEnd) });
    for (const id of wanted) p.append('account', id);
    const res = await fetch(`${base}/accounts?${p}`, {
      headers: { Authorization: auth, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`SimpleFIN refused the access URL (HTTP ${res.status}): revoked in SimpleFIN Bridge?`);
    if (res.status === 402) throw new Error('SimpleFIN Bridge subscription needs payment');
    if (!res.ok) throw new Error(`SimpleFIN /accounts HTTP ${res.status}`);
    const set = await res.json();
    for (const e of [...(set.errors ?? []), ...(set.errlist ?? [])]) {
      const msg = typeof e === 'string' ? e : (e?.msg || e?.code);
      if (msg) warnings.add(String(msg));
    }
    rows.push(...cardRows(set, wanted));
  }
  const accounts = [...new Set(rows.map((r) => r.account_name).filter(Boolean))];
  return {
    rows,
    status: { balance_usd: null, details: { accounts, days, transactions: rows.length, warnings: [...warnings] } },
  };
}

// ── handler ─────────────────────────────────────────────────────────────────
exports.sumAnthropicRows = sumAnthropicRows;
exports.sumOpenRouterActivity = sumOpenRouterActivity;
exports.cardRows = cardRows;

exports.handler = async (event) => {
  const auth = (event.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!process.env.CRON_SECRET || auth !== process.env.CRON_SECRET) return json(401, { error: 'Unauthorized' });

  const base = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_KEY;
  if (!base || !sbKey) return json(503, { error: 'Supabase not configured' });
  const upsert = async (table, conflict, rows) => {
    if (!rows.length) return;
    const res = await fetch(`${base}/rest/v1/${table}?on_conflict=${conflict}`, {
      method: 'POST',
      headers: {
        apikey: sbKey,
        Authorization: `Bearer ${sbKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) throw new Error(`Supabase ${table} upsert HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };

  const now = new Date();
  // ?days=90 backfills card charges once (SimpleFIN Bridge keeps about 90 days).
  const cardDays = Math.min(90, Math.max(1, Number(event.queryStringParameters?.days) || SIMPLEFIN_MAX_DAYS));
  const sources = [
    ['anthropic', process.env.ANTHROPIC_ADMIN_KEY, (k) => fetchAnthropic(k, now), 'cost_daily', 'service,scope,day'],
    ['openrouter', process.env.OPENROUTER_MANAGEMENT_KEY, (k) => fetchOpenRouter(k), 'cost_daily', 'service,scope,day'],
    ['card', process.env.SIMPLEFIN_ACCESS_URL, (k) => fetchCard(k, process.env.SIMPLEFIN_ACCOUNT_IDS, cardDays, now), 'card_charges', 'account_id,txn_id'],
  ];

  const results = await Promise.all(sources.map(async ([service, key, run, table, conflict]) => {
    const checked_at = now.toISOString();
    try {
      if (!key) throw new Error('API key env var not set');
      const { rows, status } = await run(key);
      const stamped = rows.map((r) => ({ ...r, updated_at: checked_at }));
      await upsert(table, conflict, stamped);
      await upsert('cost_status', 'service', [{ service, ok: true, error: null, ...status, checked_at, last_ok_at: checked_at }]);
      const total = rows.reduce((s, r) => s + r.amount_usd, 0);
      return { service, ok: true, rows: rows.length, net_usd: round4(total), balance_usd: status.balance_usd };
    } catch (e) {
      // Record the failure but keep last_ok_at and the old balance (omitted keys aren't overwritten).
      try {
        await upsert('cost_status', 'service', [{ service, ok: false, error: String(e.message).slice(0, 500), checked_at }]);
      } catch (_) { /* the table itself may be missing; the response still says what failed */ }
      return { service, ok: false, error: e.message };
    }
  }));

  return json(200, { updated: now.toISOString(), results });
};
