// stripe-metrics.js — Rob-only Stripe summary for the portal tile.
//
// GET  Authorization: Bearer <rmt session token (Rob's only — Katy is rejected)>
//
// Returns aggregated invoice + subscription + payment-link numbers for the portal tile:
//   sent_count, paid_count, pending_count, payment_link_count
//   total_received_cents, total_outstanding_cents, received_this_month_cents
//   active_subscriptions
//   livemode (true/false — reflects which Stripe key is active)
//   currency (lowercase, from the first invoice/charge — assumes single-currency setup)
//
// Pages through Stripe's invoices.list (limit 100 per page, capped at 10 pages =
// 1,000 invoices) AND paymentIntents.list for non-invoice payments (e.g. Payment Links).
// PaymentIntents that reference an invoice are excluded to avoid double-counting.

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

// Fetch succeeded PaymentIntents that are NOT linked to an invoice (i.e. Payment Links,
// manual charges, etc.). Invoice-linked PIs are already counted via invoices.list.
async function listNonInvoicePayments(stripe, { maxPages = 10, pageSize = 100 } = {}) {
  const all = [];
  let startingAfter;
  for (let page = 0; page < maxPages; page++) {
    const res = await stripe.paymentIntents.list({
      limit:          pageSize,
      starting_after: startingAfter,
    });
    // Only keep succeeded PIs with no invoice attachment
    const relevant = res.data.filter(pi => pi.status === 'succeeded' && !pi.invoice);
    all.push(...relevant);
    if (!res.has_more || res.data.length === 0) return { payments: all, truncated: false };
    startingAfter = res.data[res.data.length - 1].id;
  }
  return { payments: all, truncated: true };
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
    const now        = new Date();
    const monthStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);

    // Run invoice fetch and payment-intent fetch in parallel
    const [
      { invoices, truncated: invoicesTruncated },
      { payments, truncated: paymentsTruncated },
    ] = await Promise.all([
      listAllInvoices(stripe),
      listNonInvoicePayments(stripe).catch(() => ({ payments: [], truncated: false })),
    ]);

    // --- Invoice buckets ---
    const paid          = invoices.filter(i => i.status === 'paid');
    const open          = invoices.filter(i => i.status === 'open');
    const draft         = invoices.filter(i => i.status === 'draft');
    const uncollectible = invoices.filter(i => i.status === 'uncollectible');
    const sent          = invoices.filter(i => i.status && i.status !== 'draft');

    const sumPaid  = paid.reduce((s, i) => s + (i.amount_paid ?? 0), 0);
    const sumOpen  = open.reduce((s, i) => s + (i.amount_due  ?? 0), 0);
    const sumDraft = draft.reduce((s, i) => s + (i.amount_due  ?? 0), 0);

    const paidThisMonth    = paid.filter(i => (i.status_transitions?.paid_at ?? 0) >= monthStart);
    const sumPaidThisMonth = paidThisMonth.reduce((s, i) => s + (i.amount_paid ?? 0), 0);

    // --- Non-invoice payments (Payment Links, etc.) ---
    // PaymentIntent.created is when the PI was created; for payment links this is
    // essentially when the customer paid (the PI succeeds synchronously on completion).
    const sumPayments          = payments.reduce((s, p) => s + (p.amount ?? 0), 0);
    const paymentsThisMonth    = payments.filter(p => (p.created ?? 0) >= monthStart);
    const sumPaymentsThisMonth = paymentsThisMonth.reduce((s, p) => s + (p.amount ?? 0), 0);

    // --- Active subscriptions ---
    let activeSubsCount = 0;
    try {
      const subs = await stripe.subscriptions.list({ status: 'active', limit: 100 });
      activeSubsCount = subs.data.length + (subs.has_more ? 1 : 0);
    } catch { /* non-critical */ }

    const currency = invoices[0]?.currency ?? payments[0]?.currency ?? 'usd';
    const livemode = invoices[0]?.livemode ?? payments[0]?.livemode ?? null;

    return json(200, {
      currency,
      livemode,
      sent_count:                 sent.length,
      paid_count:                 paid.length,
      pending_count:              open.length + draft.length,
      uncollectible_count:        uncollectible.length,
      payment_link_count:         payments.length,
      total_received_cents:       sumPaid + sumPayments,
      total_outstanding_cents:    sumOpen + sumDraft,
      received_this_month_cents:  sumPaidThisMonth + sumPaymentsThisMonth,
      active_subscriptions:       activeSubsCount,
      truncated_at_1000:          invoicesTruncated || paymentsTruncated,
      generated_at:               new Date().toISOString(),
    });
  } catch (err) {
    console.error('stripe-metrics error:', err);
    return json(500, { error: err.message || 'Stripe API call failed' });
  }
};
