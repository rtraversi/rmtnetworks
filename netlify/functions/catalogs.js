// Read access to `apps_catalog` + `modules_catalog`, and cost edits on `modules_catalog`.
//
// GET                              → { apps, modules }
// PATCH ?id=<uuid>  body {...}     → update a module's catalog-level cost fields

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

const WRITABLE_FIELDS = ['one_time_cost', 'monthly_cost'];

exports.handler = async (event) => {
  if (!authOk(event)) return json(401, { error: 'Unauthorized' });

  const qp = event.queryStringParameters || {};
  const method = event.httpMethod;

  try {
    if (method === 'GET') {
      const [appsRes, modsRes] = await Promise.all([
        sbFetch('/apps_catalog?active=eq.true&order=sort_order.asc'),
        sbFetch('/modules_catalog?order=sort_order.asc'),
      ]);
      if (!appsRes.ok) return json(500, { error: await appsRes.text() });
      if (!modsRes.ok) return json(500, { error: await modsRes.text() });
      return json(200, { apps: await appsRes.json(), modules: await modsRes.json() });
    }

    if (method === 'PATCH') {
      if (!qp.id) return json(400, { error: 'id required' });
      const body = JSON.parse(event.body || '{}');
      const patch = {};
      for (const k of WRITABLE_FIELDS) if (k in body) patch[k] = body[k];
      const res = await sbFetch(`/modules_catalog?id=eq.${encodeURIComponent(qp.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
