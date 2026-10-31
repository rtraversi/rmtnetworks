// CRUD for `ideas` (ideas.html). Rob/Katy only.
//
// GET                         → all ideas, newest first
// POST   body {...}           → create an idea
// PATCH  ?id=<uuid> body {...} → update an idea
// DELETE ?id=<uuid>           → delete an idea

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
      const res = await sbFetch('/ideas?order=created_at.desc');
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const res = await sbFetch('/ideas', { method: 'POST', body: JSON.stringify(rowFrom(body)) });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    if (method === 'PATCH') {
      if (!qp.id) return json(400, { error: 'id required' });
      const body = JSON.parse(event.body || '{}');
      const res = await sbFetch(`/ideas?id=eq.${encodeURIComponent(qp.id)}`, { method: 'PATCH', body: JSON.stringify(rowFrom(body)) });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    if (method === 'DELETE') {
      if (!qp.id) return json(400, { error: 'id required' });
      const res = await sbFetch(`/ideas?id=eq.${encodeURIComponent(qp.id)}`, { method: 'DELETE' });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
