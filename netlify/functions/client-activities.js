// CRUD (read + append) for the `client_activities` table.
//
// GET  ?client_id=<uuid>                        → last 100 activities, newest first
// POST body {client_id, type, body}             → log an activity (user-entered or system-generated)

'use strict';

const { whoAmI, clientAllowed } = require('../../lib/max-scope.js');

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

const ALLOWED_TYPES = ['call', 'email', 'meeting', 'note', 'system'];

exports.handler = async (event) => {
  if (!authOk(event)) return json(401, { error: 'Unauthorized' });

  const qp = event.queryStringParameters || {};
  const method = event.httpMethod;

  try {
    if (method === 'GET') {
      if (!qp.client_id) return json(400, { error: 'client_id required' });
      if (!clientAllowed(event, qp.client_id)) return json(403, { error: 'Forbidden' });
      const res = await sbFetch(`/client_activities?client_id=eq.${encodeURIComponent(qp.client_id)}&order=created_at.desc&limit=100`);
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (!body.client_id || !body.body) return json(400, { error: 'client_id and body required' });
      if (!clientAllowed(event, body.client_id)) return json(403, { error: 'Forbidden' });
      const type = ALLOWED_TYPES.includes(body.type) ? body.type : 'note';
      const row = { client_id: body.client_id, type, body: body.body, created_by: whoAmI(event) };
      const res = await sbFetch('/client_activities', { method: 'POST', body: JSON.stringify(row) });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
