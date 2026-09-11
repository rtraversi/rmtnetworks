// payments.js — Client Payment Ledger CRUD (charges owed + payments received).
//
// GET    ?client_id=<uuid>                                              → { charges, payments }
// POST   body { client_id, kind: 'charge',  charged_on, description, amount }         → log a charge
// POST   body { client_id, kind: 'payment', paid_on, amount, method?, note? }         → log a payment
// DELETE ?kind=charge&id=<uuid>  or  ?kind=payment&id=<uuid>                           → remove a row

'use strict';

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function authOk(event) {
  const raw   = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  return (process.env.SESSION_SECRET      && token === process.env.SESSION_SECRET) ||
         (process.env.KATY_SESSION_SECRET && token === process.env.KATY_SESSION_SECRET) ||
         (process.env.MAX_SESSION_SECRET  && token === process.env.MAX_SESSION_SECRET);
}

function sbFetch(path, opts = {}) {
  return fetch(process.env.SUPABASE_URL + '/rest/v1' + path, {
    ...opts,
    headers: {
      apikey:          process.env.SUPABASE_KEY,
      Authorization:   `Bearer ${process.env.SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      Prefer:          'return=representation',
      ...(opts.headers || {}),
    },
  });
}

exports.handler = async (event) => {
  if (!authOk(event)) return json(401, { error: 'Unauthorized' });

  const qp     = event.queryStringParameters || {};
  const method = event.httpMethod;

  try {
    if (method === 'GET') {
      if (!qp.client_id) return json(400, { error: 'client_id required' });
      const [chargesRes, paymentsRes] = await Promise.all([
        sbFetch(`/client_charges?client_id=eq.${encodeURIComponent(qp.client_id)}&order=charged_on.desc,created_at.desc`),
        sbFetch(`/client_payments?client_id=eq.${encodeURIComponent(qp.client_id)}&order=paid_on.desc,created_at.desc`),
      ]);
      if (!chargesRes.ok)  return json(500, { error: await chargesRes.text() });
      if (!paymentsRes.ok) return json(500, { error: await paymentsRes.text() });
      return json(200, { charges: await chargesRes.json(), payments: await paymentsRes.json() });
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');

      if (body.kind === 'charge') {
        if (!body.client_id || !body.charged_on || !body.description || body.amount == null) {
          return json(400, { error: 'client_id, charged_on, description, and amount required' });
        }
        const row = {
          client_id:   body.client_id,
          charged_on:  body.charged_on,
          description: body.description.trim(),
          amount:      parseFloat(body.amount),
        };
        const res = await sbFetch('/client_charges', { method: 'POST', body: JSON.stringify(row) });
        if (!res.ok) return json(500, { error: await res.text() });
        return json(200, (await res.json())[0]);
      }

      if (body.kind === 'payment') {
        if (!body.client_id || !body.paid_on || body.amount == null) {
          return json(400, { error: 'client_id, paid_on, and amount required' });
        }
        const row = {
          client_id: body.client_id,
          paid_on:   body.paid_on,
          amount:    parseFloat(body.amount),
          method:    body.method || null,
          note:      body.note   || null,
        };
        const res = await sbFetch('/client_payments', { method: 'POST', body: JSON.stringify(row) });
        if (!res.ok) return json(500, { error: await res.text() });
        return json(200, (await res.json())[0]);
      }

      return json(400, { error: "kind must be 'charge' or 'payment'" });
    }

    if (method === 'DELETE') {
      if (!qp.id || !qp.kind) return json(400, { error: 'kind and id required' });
      const table = qp.kind === 'charge' ? 'client_charges' : qp.kind === 'payment' ? 'client_payments' : null;
      if (!table) return json(400, { error: "kind must be 'charge' or 'payment'" });
      const res = await sbFetch(`/${table}?id=eq.${encodeURIComponent(qp.id)}`, { method: 'DELETE' });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
