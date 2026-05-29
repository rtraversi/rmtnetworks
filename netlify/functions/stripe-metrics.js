// stripe-metrics.js — Rob-only Stripe summary for the portal tile.
//
// GET  Authorization: Bearer <rmt session token (Rob's only — Katy is rejected)>
//
// Returns aggregated invoice + subscription numbers for the portal tile:
//   sent_count, paid_count, pending_count
//   total_received_cents, total_outstanding_cents, received_this_month_cents
//   active_subscriptions
//   livemode (true/false — reflects which Stripe key is active)
//   currency (lowercase, from the first invoice — assumes single-currency setup)
//
// Pages through Stripe's invoices.list (limit 100 per page, capped at 10 pages =
// 1,000 invoices). At >1,000 invoices we should switch to cached running totals
// instead of paging every page-load.

'use strict';

const Stripe = require('stripe');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const json = (status, body) => ({
  statusCode: status,
  headers: { ...CORS, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// Rob-only — Katy's token is explicitly rejected even though it would pass
// the generic /verify endpoint. This guards Rob's private revenue data.
function isRob(authHeader) {
  const token = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  if (!process.env.SESSION_SECRET) return false;
  return token === process.env.SESSION_SECRET;
}

// Page through invoices.list with a safety cap so a runaway loop can't burn
// through the function budget.
async function listAllInvoices(stripe, { maxPages = 10, pageSize = 100 } = {}) {
  const all = [];
  let startingAfter;
  for (let page = 0; page < maxPages; page++) {
    const res = await stripe.invoices.list({
      limit:          pageSize,
      starting_after: startingAfter,
    });
    all.push(...res.data);
    if (!res.has_more || res.data.length === 0) return { invoices: all, truncated: false };
    startingAfter = res.data[res.data.length - 1].id;
  }
  return { invoices: all, truncated: true };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS };
  if (event.httpMethod !== 'GET')     return json(405, { error: 'Method not allowed' });

  if (!isRob(event.headers.authorization || event.headers.Authorization)) {
    return json(401, { error: 'Unauthorized' });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return json(503, {
      error: 'STRIPE_SECRET_KEY not configured',
      hint:  'Add STRIPE_SECRET_KEY (sk_live_… or sk_test_…) to Netlify env vars.',
    });
  }

  const stripe = new Stripe(stripeKey, { apiVersion: '2024-11-20.acacia' });

  try {
    // Month-start in UTC (paid_at is a unix timestamp)
    const now        = new Date();
    const monthStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);

    const { invoices, truncated } = await listAllInvoices(stripe);

    // Status buckets (https://docs.stripe.com/api/invoices/object#invoice_object-status)
    const paid          = invoices.filter(i => i.status === 'paid');
    const open          = invoices.filter(i => i.status === 'open');
    const draft         = invoices.filter(i => i.status === 'draft');
    const uncollectible = invoices.filter(i => i.status === 'uncollectible');

    // "Sent" = anything that's left the draft stage (open/paid/uncollectible/void)
    const sent = invoices.filter(i => i.status && i.status !== 'draft');

    const sumPaid    = paid.reduce((s, i) => s + (i.amount_paid ?? 0),      0);
    const sumOpen    = open.reduce((s, i) => s + (i.amount_due  ?? 0),      0);
    const sumDraft   = draft.reduce((s, i) => s + (i.amount_due ?? 0),      0);
    const outstanding = sumOpen + sumDraft;

    const paidThisMonth      = paid.filter(i => (i.status_transitions?.paid_at ?? 0) >= monthStart);
    const sumPaidThisMonth   = paidThisMonth.reduce((s, i) => s + (i.amount_paid ?? 0), 0);

    // Active subscriptions (single quick page — Stripe defaults to 10, raise to 100)
    let activeSubsCount = 0;
    try {
      const subs = await stripe.subscriptions.list({ status: 'active', limit: 100 });
      activeSubsCount = subs.data.length + (subs.has_more ? 1 : 0); // approximate; bump if >100
    } catch { /* non-critical — leave 0 */ }

    return json(200, {
      currency:                   invoices[0]?.currency ?? 'usd',
      livemode:                   invoices[0]?.livemode ?? null,
      sent_count:                 sent.length,
      paid_count:                 paid.length,
      pending_count:              open.length + draft.length,
      uncollectible_count:        uncollectible.length,
      total_received_cents:       sumPaid,
      total_outstanding_cents:    outstanding,
      received_this_month_cents:  sumPaidThisMonth,
      active_subscriptions:       activeSubsCount,
      truncated_at_1000:          truncated,
      generated_at:               new Date().toISOString(),
    });
  } catch (err) {
    console.error('stripe-metrics error:', err);
    return json(500, { error: err.message || 'Stripe API call failed' });
  }
};
