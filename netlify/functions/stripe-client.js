// stripe-client.js — Per-client Stripe payment history
// GET /.netlify/functions/stripe-client?email=<email>
// Authorization: Bearer <session token>
//
// Looks up a Stripe customer by email (payment link payers) and returns
// their full payment history + totals.

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

function authOk(authHeader) {
  const token = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  return (process.env.SESSION_SECRET      && token === process.env.SESSION_SECRET) ||
         (process.env.KATY_SESSION_SECRET && token === process.env.KATY_SESSION_SECRET);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS };
  if (event.httpMethod !== 'GET')     return json(405, { error: 'Method not allowed' });

  if (!authOk(event.headers.authorization || event.headers.Authorization)) {
    return json(401, { error: 'Unauthorized' });
  }

  const email = ((event.queryStringParameters || {}).email || '').trim().toLowerCase();
  if (!email) return json(400, { error: 'email query param required' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json(503, { error: 'STRIPE_SECRET_KEY not configured' });

  const stripe = new Stripe(stripeKey, { apiVersion: '2024-11-20.acacia' });

  try {
    const customers = await stripe.customers.list({ email, limit: 5 });

    if (customers.data.length === 0) {
      return json(200, { found: false, email, payments: [], total_cents: 0, this_month_cents: 0 });
    }

    const customer = customers.data[0];

    const [piRes, invRes] = await Promise.all([
      stripe.paymentIntents.list({ customer: customer.id, limit: 50 }),
      stripe.invoices.list({ customer: customer.id, limit: 50 }),
    ]);

    const payments = piRes.data
      .filter(pi => pi.status === 'succeeded')
      .map(pi => ({
        id:           pi.id,
        type:         'payment',
        amount_cents: pi.amount_received,
        currency:     pi.currency,
        date:         new Date(pi.created * 1000).toISOString().split('T')[0],
        description:  pi.description || null,
      }));

    const piChargeIds = new Set(piRes.data.map(p => p.latest_charge).filter(Boolean));
    const invoicePayments = invRes.data
      .filter(inv => inv.status === 'paid' && !piChargeIds.has(inv.charge))
      .map(inv => ({
        id:           inv.id,
        type:         'invoice',
        amount_cents: inv.amount_paid,
        currency:     inv.currency,
        date:         new Date((inv.status_transitions?.paid_at || inv.created) * 1000).toISOString().split('T')[0],
        description:  inv.description || null,
      }));

    const allPayments = [...payments, ...invoicePayments]
      .sort((a, b) => b.date.localeCompare(a.date));

    const total_cents = allPayments.reduce((s, p) => s + p.amount_cents, 0);

    const now        = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const this_month_cents = allPayments
      .filter(p => new Date(p.date) >= monthStart)
      .reduce((s, p) => s + p.amount_cents, 0);

    return json(200, {
      found:            true,
      email,
      customer_id:      customer.id,
      customer_name:    customer.name,
      payments:         allPayments,
      total_cents,
      this_month_cents,
      currency:         allPayments[0]?.currency ?? 'usd',
    });
  } catch (err) {
    console.error('stripe-client error:', err);
    return json(500, { error: err.message || 'Stripe API call failed' });
  }
};
