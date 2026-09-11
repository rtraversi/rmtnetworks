// CRUD for the `client_subscriptions` table.
//
// GET    ?client_id=<uuid>              → subscriptions for a client, ordered by service
// POST   body {client_id, service, ...} → create a subscription
// PATCH  ?id=<uuid>  body {...}         → update a subscription
// DELETE ?id=<uuid>                     → delete a subscription

'use strict';

const { whoAmI, isMax, clientAllowed } = require('../../lib/max-scope.js');

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function authOk(event) {
  return !!whoAmI(event);
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

async function rowClientId(id) {
  const res = await sbFetch(`/client_subscriptions?id=eq.${encodeURIComponent(id)}&select=client_id`);
  if (!res.ok) return null;
  const [row] = await res.json();
  return row ? row.client_id : null;
}

const WRITABLE_FIELDS = ['service', 'signed_up_date', 'billing_cycle', 'price', 'expiration_date', 'login', 'website_url', 'notes'];

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
      if (!qp.client_id) return json(400, { error: 'client_id required' });
      if (!clientAllowed(event, qp.client_id)) return json(403, { error: 'Forbidden' });
      const res = await sbFetch(`/client_subscriptions?client_id=eq.${encodeURIComponent(qp.client_id)}&order=service.asc`);
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (!body.client_id || !body.service) return json(400, { error: 'client_id and service required' });
      if (!clientAllowed(event, body.client_id)) return json(403, { error: 'Forbidden' });
      const row = pickWritable(body);
      row.client_id = body.client_id;
      const res = await sbFetch('/client_subscriptions', { method: 'POST', body: JSON.stringify(row) });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    if (method === 'PATCH') {
      if (!qp.id) return json(400, { error: 'id required' });
      if (isMax(event) && !clientAllowed(event, await rowClientId(qp.id))) return json(403, { error: 'Forbidden' });
      const body = JSON.parse(event.body || '{}');
      const patch = pickWritable(body);
      const res = await sbFetch(`/client_subscriptions?id=eq.${encodeURIComponent(qp.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    if (method === 'DELETE') {
      if (!qp.id) return json(400, { error: 'id required' });
      if (isMax(event) && !clientAllowed(event, await rowClientId(qp.id))) return json(403, { error: 'Forbidden' });
      const res = await sbFetch(`/client_subscriptions?id=eq.${encodeURIComponent(qp.id)}`, { method: 'DELETE' });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
