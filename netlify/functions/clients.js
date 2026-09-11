// CRUD for the `clients` table.
//
// GET    (list)         → clients with nested login/subscription/ledger counts, ordered by name
// POST   body {...}     → create a client
// PATCH  ?id=<uuid>      body {...}   → update a client (edit form, status change, pipeline stage change)
// DELETE ?id=<uuid>     → delete a client (cascades to child rows)

'use strict';

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function authOk(event) {
  const raw = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  return (process.env.SESSION_SECRET && token === process.env.SESSION_SECRET) ||
         (process.env.KATY_SESSION_SECRET && token === process.env.KATY_SESSION_SECRET) ||
         (process.env.MAX_SESSION_SECRET && token === process.env.MAX_SESSION_SECRET);
}

function sbFetch(path, opts = {}) {
  return fetch(process.env.SUPABASE_URL + '/rest/v1' + path, {
    ...opts,
    headers: {
      apikey: process.env.SUPABASE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
}

const WRITABLE_FIELDS = [
  'name', 'company', 'email', 'phone', 'address', 'website',
  'status', 'pipeline_stage', 'deal_value', 'lost_reason',
  'date_hired', 'contract_renewal_date', 'payment_terms', 'next_followup_date',
  'contract_url', 'stripe_customer_email', 'scope_of_work', 'notes',
];

function pickWritable(body) {
  const row = {};
  for (const k of WRITABLE_FIELDS) if (k in body) row[k] = body[k];
  return row;
}

exports.handler = async (event) => {
  if (!authOk(event)) return json(401, { error: 'Unauthorized' });

  const qp = event.queryStringParameters || {};
  const method = event.httpMethod;

  try {
    if (method === 'GET') {
      const res = await sbFetch(
        '/clients?select=*,client_logins(id),client_subscriptions(id,price,billing_cycle),client_charges(amount),client_payments(amount)&order=name.asc'
      );
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (!body.name || !String(body.name).trim()) return json(400, { error: 'name required' });
      const row = pickWritable(body);
      row.name = String(row.name).trim();
      const res = await sbFetch('/clients', { method: 'POST', body: JSON.stringify(row) });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    if (method === 'PATCH') {
      if (!qp.id) return json(400, { error: 'id required' });
      const body = JSON.parse(event.body || '{}');
      const patch = pickWritable(body);
      patch.updated_at = new Date().toISOString();
      const res = await sbFetch(`/clients?id=eq.${encodeURIComponent(qp.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    if (method === 'DELETE') {
      if (!qp.id) return json(400, { error: 'id required' });
      const res = await sbFetch(`/clients?id=eq.${encodeURIComponent(qp.id)}`, { method: 'DELETE' });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
