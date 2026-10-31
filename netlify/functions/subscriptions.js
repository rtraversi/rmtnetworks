// CRUD for `subscriptions` (tracker.html). Rob/Katy only.
//
// GET                         → all subscriptions, by name
// POST   body {...}           → add a subscription
// PATCH  ?id=<uuid> body {...} → update a subscription
// DELETE ?id=<uuid>           → remove a subscription

'use strict';

const { whoAmI, isMax } = require('../../lib/max-scope.js');
const { authenticate } = require('../../lib/portal-auth.js');

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function sbFetch(path, opts = {}) {
  return fetch(process.env.SUPABASE_URL + '/rest/v1' + path, {
    ...opts,
    headers: {
      apikey: process.env.SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
}

function rowFrom(body) {
  const { id, created_at, ...row } = body;
  return row;
}

exports.handler = async (event) => {
  await authenticate(event);
  if (!whoAmI(event) || isMax(event)) return json(401, { error: 'Unauthorized' });

  const qp = event.queryStringParameters || {};
  const method = event.httpMethod;

  try {
    if (method === 'GET') {
      const res = await sbFetch('/subscriptions?order=name.asc');
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const res = await sbFetch('/subscriptions', { method: 'POST', body: JSON.stringify(rowFrom(body)) });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    if (method === 'PATCH') {
      if (!qp.id) return json(400, { error: 'id required' });
      const body = JSON.parse(event.body || '{}');
      const res = await sbFetch(`/subscriptions?id=eq.${encodeURIComponent(qp.id)}`, { method: 'PATCH', body: JSON.stringify(rowFrom(body)) });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    if (method === 'DELETE') {
      if (!qp.id) return json(400, { error: 'id required' });
      const res = await sbFetch(`/subscriptions?id=eq.${encodeURIComponent(qp.id)}`, { method: 'DELETE' });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
