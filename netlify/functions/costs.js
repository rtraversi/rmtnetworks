// costs.js — data for the Costs screen (costs.html) and the dashboard's spend KPI.
//
// GET  Authorization: Bearer <Supabase session (Rob or Katy)>
//
// Returns {
//   generated_at, month: 'YYYY-MM',
//   usage:  [{ service, label, ok, error, checked_at, last_ok_at, balance_usd,
//              mtd_usd, last_month_usd, scopes: [{ scope, name, mtd_usd, last_month_usd }],
//              daily: [{ day, amount_usd }] }],          // usage-billed vendors (cost_daily)
//   netlify: { used, limit, unit, last_updated } | null,  // build credits (usage_metrics)
//   fixed:  [{ name, plan, category, price, billing_cycle, monthly_usd, renewal_date }],
//   totals: { fixed_monthly_usd, usage_mtd_usd, month_usd }
// }
//
// Reads snapshots only; vendor APIs are called by fetch-costs.js on a schedule.
// Required env: SUPABASE_URL, SUPABASE_KEY.

'use strict';
const { authenticate } = require('../../lib/portal-auth.js');

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const LABELS = {
  anthropic:  'Anthropic API · client org',
  openrouter: 'OpenRouter',
};

const round2 = (n) => Math.round(n * 100) / 100;

// Monthly equivalent of a fixed plan; null for free, usage-billed or unpriced rows.
// Exported for tests.
function monthlyUsd(sub) {
  const p = Number(sub.price);
  if (!p || p <= 0) return null;
  if (sub.billing_cycle === 'monthly') return round2(p);
  if (sub.billing_cycle === 'annual') return round2(p / 12);
  return null;
}

// Groups cost_daily rows into per-service month-to-date / last-month totals.
// Exported for tests.
function summarizeUsage(rows, statuses, now = new Date()) {
  const ym = (d) => d.slice(0, 7);
  const thisMonth = now.toISOString().slice(0, 7);
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);

  const services = new Set([...statuses.map((s) => s.service), ...rows.map((r) => r.service)]);
  return [...services].sort().map((service) => {
    const st = statuses.find((s) => s.service === service) || {};
    const mine = rows.filter((r) => r.service === service);
    const names = (st.details && st.details.scopes) || {};

    const byScope = new Map();
    const byDay = new Map();
    let mtd = 0, last = 0;
    for (const r of mine) {
      const amt = Number(r.amount_usd) || 0;
      const m = ym(r.day);
      const s = byScope.get(r.scope) || { mtd: 0, last: 0 };
      if (m === thisMonth) { mtd += amt; s.mtd += amt; }
      if (m === prev) { last += amt; s.last += amt; }
      byScope.set(r.scope, s);
      byDay.set(r.day, (byDay.get(r.day) || 0) + amt);
    }

    return {
      service,
      label: LABELS[service] || service,
      ok: st.ok ?? null,
      error: st.error ?? null,
      checked_at: st.checked_at ?? null,
      last_ok_at: st.last_ok_at ?? null,
      balance_usd: st.balance_usd == null ? null : Number(st.balance_usd),
      mtd_usd: round2(mtd),
      last_month_usd: round2(last),
      scopes: [...byScope.entries()]
        .filter(([scope]) => scope !== '')
        .map(([scope, s]) => ({ scope, name: names[scope] || scope, mtd_usd: round2(s.mtd), last_month_usd: round2(s.last) }))
        .sort((a, b) => b.mtd_usd - a.mtd_usd || b.last_month_usd - a.last_month_usd),
      daily: [...byDay.entries()].sort().map(([day, amount_usd]) => ({ day, amount_usd: round2(amount_usd) })),
    };
  });
}

exports.monthlyUsd = monthlyUsd;
exports.summarizeUsage = summarizeUsage;

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  if (!['Rob', 'Katy'].includes(await authenticate(event))) return json(401, { error: 'Unauthorized' });

  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!base || !key) return json(503, { error: 'Supabase not configured' });
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const get = async (path) => {
    const r = await fetch(`${base}/rest/v1/${path}`, { headers });
    if (!r.ok) throw new Error(`${path.split('?')[0]}: HTTP ${r.status}`);
    return r.json();
  };

  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);

  try {
    const [rows, statuses, subs, netlify] = await Promise.all([
      get(`cost_daily?select=service,scope,day,amount_usd&day=gte.${since}&order=day.asc`),
      get('cost_status?select=*'),
      get('subscriptions?select=name,plan,category,price,billing_cycle,renewal_date&is_active=eq.true&order=name.asc'),
      get('usage_metrics?select=used_value,limit_value,unit,last_updated&service_name=eq.Netlify&metric_name=eq.credits&limit=1'),
    ]);

    const usage = summarizeUsage(rows, statuses, now);
    const fixed = subs
      .map((s) => ({ ...s, price: Number(s.price), monthly_usd: monthlyUsd(s) }))
      .filter((s) => s.monthly_usd != null)
      .sort((a, b) => b.monthly_usd - a.monthly_usd);

    const fixedMonthly = round2(fixed.reduce((t, s) => t + s.monthly_usd, 0));
    const usageMtd = round2(usage.reduce((t, u) => t + u.mtd_usd, 0));
    const n = netlify[0];

    return json(200, {
      generated_at: now.toISOString(),
      month: now.toISOString().slice(0, 7),
      usage,
      netlify: n ? { used: Number(n.used_value), limit: Number(n.limit_value), unit: n.unit, last_updated: n.last_updated } : null,
      fixed,
      totals: { fixed_monthly_usd: fixedMonthly, usage_mtd_usd: usageMtd, month_usd: round2(fixedMonthly + usageMtd) },
    });
  } catch (e) {
    return json(502, { error: e.message || 'Unknown error' });
  }
};
