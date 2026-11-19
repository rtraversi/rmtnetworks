// costs.js — data for the Costs screen (costs.html) and the dashboard's spend KPI.
//
// GET   Authorization: Bearer <Supabase session (Rob or Katy)>
// POST  { ignore: "<text>", note? } adds a charge_ignores pattern (same auth)
//
// GET returns {
//   generated_at, month: 'YYYY-MM',
//   usage:  [{ service, label, ok, error, checked_at, last_ok_at, balance_usd,
//              mtd_usd, last_month_usd, scopes: [...], daily: [...] }],  // API usage feeds
//   card:   { ok, error, checked_at, last_ok_at, accounts, warnings,
//             vendors: [{ label, pattern, billing, annual, mtd_usd, last_month_usd,
//                         charges_90d, last: { day, amount_usd }, flags }],
//             unmatched: [{ merchant, sample, count, total_usd, last_day, last_amount_usd }] },
//   netlify: { used, limit, unit, last_updated } | null,  // build credits (usage_metrics)
//   fixed:  [{ name, plan, category, price, billing_cycle, monthly_usd, renewal_date,
//              card_match, card_status: charged|expected|annual|not_on_card }],
//   totals: { month_usd, card_mtd_usd, still_due_usd, fixed_monthly_usd, usage_mtd_usd }
// }
//
// Reads snapshots only; vendor APIs and SimpleFIN are called by fetch-costs.js on a schedule.
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

// Merchant key for grouping unmatched charges: "OPENAI *CHATGPT SUBSCR 123" → "OPENAI".
// Exported for tests.
function merchantKey(desc) {
  let d = String(desc || '').toUpperCase();
  // Payment processors put the real merchant after the star: "SQ *JOE'S CAFE".
  const star = d.match(/^(SQ|TST|PAYPAL|PP|SP|DD|IN|GOOGLE|APPLE\.COM\/BILL)\s*\*\s*(.+)$/);
  d = star ? star[2] : d;
  const k = d
    .replace(/\*.*$/, '').replace(/[#0-9].*$/, '')
    .replace(/[^A-Z&' ]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').slice(0, 3).join(' ');
  return k || String(desc || '').trim().toUpperCase() || '(no description)';
}

// Card charges (SimpleFIN) matched to subscriptions by card_match, and what the month
// will cost. Exported for tests.
//
// For the month estimate:
//   • monthly and usage-billed vendors on the card count what they actually charged;
//   • a monthly plan not charged yet this month (or paid some other way) adds its price;
//   • annual plans always add price ÷ 12, and their card charges are left out of the
//     month so a renewal doesn't count twice.
function summarizeCard(charges, subs, ignores, now = new Date()) {
  const thisMonth = now.toISOString().slice(0, 7);
  const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const dayMs = 86400000;
  const daysAgo = (d) => Math.floor((now.getTime() - Date.parse(d + 'T12:00:00Z')) / dayMs);

  const patterns = subs.filter((s) => s.card_match && s.card_match.trim())
    .map((s) => ({ sub: s, p: s.card_match.trim().toLowerCase() }));
  const ignorePats = ignores.map((i) => String(i.pattern || '').trim().toLowerCase()).filter(Boolean);

  const vendors = new Map();   // pattern → vendor summary
  const unmatched = new Map(); // merchant key → summary

  const sorted = [...charges].sort((a, b) => a.posted_on.localeCompare(b.posted_on));
  for (const c of sorted) {
    const desc = String(c.description || '');
    const lower = desc.toLowerCase();
    const amt = -Number(c.amount_usd); // positive = money out
    const hit = patterns.find((x) => lower.includes(x.p));
    if (hit) {
      const v = vendors.get(hit.p) || { pattern: hit.sub.card_match.trim(), subs: [], mtd: 0, last_month: 0, count: 0, last: null };
      for (const x of patterns) if (x.p === hit.p && !v.subs.includes(x.sub)) v.subs.push(x.sub);
      const m = c.posted_on.slice(0, 7);
      if (m === thisMonth) v.mtd += amt;
      if (m === prevMonth) v.last_month += amt;
      if (amt > 0) { v.count += 1; v.last = { day: c.posted_on, amount_usd: round2(amt) }; }
      vendors.set(hit.p, v);
      continue;
    }
    if (amt <= 0 || ignorePats.some((p) => lower.includes(p))) continue;
    const k = merchantKey(desc);
    const u = unmatched.get(k) || { merchant: k, sample: desc, count: 0, total_usd: 0, last_day: null, last_amount_usd: null };
    u.count += 1;
    u.total_usd += amt;
    u.last_day = c.posted_on;
    u.last_amount_usd = round2(amt);
    unmatched.set(k, u);
  }

  const vendorList = [...vendors.values()].map((v) => {
    const cycles = [...new Set(v.subs.map((s) => s.billing_cycle))];
    const annual = cycles.length === 1 && cycles[0] === 'annual';
    const monthlyPrice = v.subs.filter((s) => s.billing_cycle === 'monthly').reduce((t, s) => t + (Number(s.price) || 0), 0);
    const flags = [];
    if (cycles.includes('monthly') && (!v.last || daysAgo(v.last.day) > 40)) flags.push('No charge in 40+ days');
    if (cycles.length === 1 && cycles[0] === 'monthly' && monthlyPrice > 0 && v.last
        && Math.abs(v.last.amount_usd - monthlyPrice) / monthlyPrice > 0.05) {
      flags.push(`Last charge ${v.last.amount_usd.toFixed(2)} vs plan ${monthlyPrice.toFixed(2)}`);
    }
    return {
      label: [...new Set(v.subs.map((s) => s.name))].join(' / '),
      pattern: v.pattern,
      billing: cycles.join(' + '),
      annual,
      mtd_usd: round2(v.mtd),
      last_month_usd: round2(v.last_month),
      charges_90d: v.count,
      last: v.last,
      flags,
    };
  }).sort((a, b) => b.mtd_usd - a.mtd_usd || b.last_month_usd - a.last_month_usd);

  const charged = new Set(vendorList.filter((v) => v.mtd_usd > 0).map((v) => v.pattern.toLowerCase()));
  const plans = subs.map((s) => {
    const monthly = monthlyUsd(s);
    if (monthly == null) return null;
    const p = (s.card_match || '').trim().toLowerCase();
    let status;
    if (s.billing_cycle === 'annual') status = 'annual';
    else if (!p) status = 'not_on_card';
    else status = charged.has(p) ? 'charged' : 'expected';
    return { name: s.name, status, still_due_usd: status === 'charged' ? 0 : monthly };
  }).filter(Boolean);

  const cardMtd = vendorList.filter((v) => !v.annual).reduce((t, v) => t + v.mtd_usd, 0);
  const stillDue = plans.reduce((t, p) => t + p.still_due_usd, 0);

  return {
    vendors: vendorList,
    unmatched: [...unmatched.values()]
      .filter((u) => u.count >= 2 || u.total_usd >= 50)
      .map((u) => ({ ...u, total_usd: round2(u.total_usd) }))
      .sort((a, b) => b.total_usd - a.total_usd),
    plan_status: Object.fromEntries(plans.map((p) => [p.name, p.status])),
    card_mtd_usd: round2(cardMtd),
    still_due_usd: round2(stillDue),
  };
}

exports.monthlyUsd = monthlyUsd;
exports.summarizeUsage = summarizeUsage;
exports.summarizeCard = summarizeCard;
exports.merchantKey = merchantKey;

exports.handler = async (event) => {
  if (!['GET', 'POST'].includes(event.httpMethod)) return json(405, { error: 'Method not allowed' });
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

  // POST { ignore: "<text in the description>", note? } — hide a merchant from the
  // "recurring charges with no match" list (card payments, personal charges...).
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad JSON' }); }
    const pattern = String(body.ignore || '').trim();
    if (pattern.length < 3 || pattern.length > 80) return json(400, { error: 'ignore must be 3-80 characters' });
    const r = await fetch(`${base}/rest/v1/charge_ignores?on_conflict=pattern`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ pattern, note: String(body.note || '').slice(0, 200) || null }),
    });
    if (!r.ok) return json(502, { error: `charge_ignores: HTTP ${r.status}` });
    return json(200, { ok: true });
  }

  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
  const cardSince = new Date(now.getTime() - 95 * 86400000).toISOString().slice(0, 10);

  try {
    const [rows, statuses, subs, netlify, charges, ignores] = await Promise.all([
      get(`cost_daily?select=service,scope,day,amount_usd&day=gte.${since}&order=day.asc`),
      get('cost_status?select=*'),
      get('subscriptions?select=name,plan,category,price,billing_cycle,renewal_date,card_match&is_active=eq.true&order=name.asc'),
      get('usage_metrics?select=used_value,limit_value,unit,last_updated&service_name=eq.Netlify&metric_name=eq.credits&limit=1'),
      get(`card_charges?select=posted_on,amount_usd,description&posted_on=gte.${cardSince}&order=posted_on.asc&limit=5000`),
      get('charge_ignores?select=pattern'),
    ]);

    const cardStatus = statuses.find((s) => s.service === 'card') || null;
    const usage = summarizeUsage(rows, statuses.filter((s) => s.service !== 'card'), now);
    const card = summarizeCard(charges, subs, ignores, now);
    const fixed = subs
      .map((s) => ({ ...s, price: Number(s.price), monthly_usd: monthlyUsd(s), card_status: card.plan_status[s.name] || null }))
      .filter((s) => s.monthly_usd != null)
      .sort((a, b) => b.monthly_usd - a.monthly_usd);

    const fixedMonthly = round2(fixed.reduce((t, s) => t + s.monthly_usd, 0));
    const usageMtd = round2(usage.reduce((t, u) => t + u.mtd_usd, 0));
    const n = netlify[0];

    return json(200, {
      generated_at: now.toISOString(),
      month: now.toISOString().slice(0, 7),
      usage,
      card: {
        ok: cardStatus ? cardStatus.ok : null,
        error: cardStatus ? cardStatus.error : null,
        checked_at: cardStatus ? cardStatus.checked_at : null,
        last_ok_at: cardStatus ? cardStatus.last_ok_at : null,
        accounts: (cardStatus && cardStatus.details && cardStatus.details.accounts) || [],
        warnings: (cardStatus && cardStatus.details && cardStatus.details.warnings) || [],
        vendors: card.vendors,
        unmatched: card.unmatched,
      },
      netlify: n ? { used: Number(n.used_value), limit: Number(n.limit_value), unit: n.unit, last_updated: n.last_updated } : null,
      fixed,
      totals: {
        // The month: what the card has been charged so far for monthly and usage-billed
        // vendors, plus plans still to come (not charged yet, paid elsewhere, or annual ÷ 12).
        month_usd: round2(card.card_mtd_usd + card.still_due_usd),
        card_mtd_usd: card.card_mtd_usd,
        still_due_usd: card.still_due_usd,
        fixed_monthly_usd: fixedMonthly,   // every priced plan at its monthly equivalent
        usage_mtd_usd: usageMtd,           // API usage feeds (billed through the card; not added)
      },
    });
  } catch (e) {
    return json(502, { error: e.message || 'Unknown error' });
  }
};
