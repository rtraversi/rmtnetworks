// Read access to `client_apps` + `client_modules`, and toggle writes on `client_modules`.
// `client_apps` has no mutation path today (toggling only happens for modules).
//
// GET                                        ?client_id=<uuid>  → { apps, modules }
// POST   body {client_id, module_id, enabled}                  → create a client_modules row
// PATCH  ?id=<uuid>  body {enabled}                             → update a client_modules row

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

exports.handler = async (event) => {
  if (!authOk(event)) return json(401, { error: 'Unauthorized' });

  const qp = event.queryStringParameters || {};
  const method = event.httpMethod;

  try {
    if (method === 'GET') {
      if (!qp.client_id) return json(400, { error: 'client_id required' });
      const cid = encodeURIComponent(qp.client_id);
      const [appsRes, modsRes] = await Promise.all([
        sbFetch(`/client_apps?client_id=eq.${cid}`),
        sbFetch(`/client_modules?client_id=eq.${cid}`),
      ]);
      if (!appsRes.ok) return json(500, { error: await appsRes.text() });
      if (!modsRes.ok) return json(500, { error: await modsRes.text() });
      return json(200, { apps: await appsRes.json(), modules: await modsRes.json() });
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (!body.client_id || !body.module_id) return json(400, { error: 'client_id and module_id required' });
      const row = { client_id: body.client_id, module_id: body.module_id, enabled: !!body.enabled };
      const res = await sbFetch('/client_modules', { method: 'POST', body: JSON.stringify(row) });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    if (method === 'PATCH') {
      if (!qp.id) return json(400, { error: 'id required' });
      const body = JSON.parse(event.body || '{}');
      const patch = {};
      if ('enabled' in body) patch.enabled = !!body.enabled;
      if ('one_time_cost_override' in body) patch.one_time_cost_override = body.one_time_cost_override;
      if ('monthly_cost_override' in body) patch.monthly_cost_override = body.monthly_cost_override;
      const res = await sbFetch(`/client_modules?id=eq.${encodeURIComponent(qp.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, await res.json());
    }

    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
