// Client-card subscriptions (`client_subscriptions`) as cost rows next to Rob's own
// `subscriptions`, for the Subscriptions page (tracker.html) and the Costs screen.
//
// A service on a client's card is one Rob pays for that client (a client's Cloudflare
// account, a client's Supabase org). It shows up with the client's name, and its price
// counts toward the totals. Rows on Rob's own list with no client are business costs.
//
// Card matching: a client row has no card_match of its own. It borrows the text rule of
// the business row whose card_match appears in the service name ("Supabase PRO" →
// "Supabase"), so its charges land under the same vendor on the Costs screen.
'use strict';

const { nextMonthly } = require('./renewal.js');

const CYCLE = { monthly: 'monthly', annually: 'annual', payg: 'usage' };

// Text-only card_match rule (no exact amount) that fits this service name, or null.
function borrowedMatch(service, subs) {
  const name = String(service || '').toLowerCase();
  const hit = (subs || []).find((s) => {
    const p = String(s.card_match || '').trim().toLowerCase();
    return p && (s.card_amount == null || s.card_amount === '') && name.includes(p);
  });
  return hit ? hit.card_match.trim() : null;
}

// rows: client_subscriptions joined with clients(name) as `client`.
// subs: Rob's subscriptions (for card_match). today: YYYY-MM-DD.
function clientCostRows(rows, subs, today) {
  return (rows || []).map((r) => {
    const billing = CYCLE[r.billing_cycle] || r.billing_cycle || 'monthly';
    // The client card sets an expiration a month out and never moves it; show the
    // next due date instead of a stale one.
    const due = r.expiration_date && billing === 'monthly' && today
      ? nextMonthly(r.expiration_date, today) : r.expiration_date || null;
    return {
      id: r.id,
      source: 'client',
      client_id: r.client_id,
      client_name: (r.client && r.client.name) || 'Client',
      name: r.service,
      plan: null,
      category: 'Client',
      price: r.price == null ? null : Number(r.price),
      billing_cycle: billing,
      renewal_date: due,
      login_email: r.login || null,
      website_url: r.website_url || null,
      notes: r.notes || null,
      card_match: borrowedMatch(r.service, subs),
      card_amount: null,
      is_active: true,
    };
  });
}

module.exports = { clientCostRows, borrowedMatch };
