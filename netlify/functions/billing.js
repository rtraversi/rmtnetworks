// billing.js — Monthly billing ledger CRUD.
//
// GET  ?client_id=<uuid>&month=YYYY-MM          → { month_record, adjustments }
// POST body { client_id, month, status?, notes? }          → upsert month record
// POST body { adj: true, billing_month_id, description, amount, category? } → add adjustment
// PATCH ?adj_id=<uuid> body { description?, amount?, category? }            → edit adjustment
// DELETE ?adj_id=<uuid>                                                      → remove adjustment
// DELETE ?month_id=<uuid>                                                    → reset month record

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
         (process.env.KATY_SESSION_SECRET && token === process.env.KATY_SESSION_SECRET);
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

// Normalize any YYYY-MM or YYYY-MM-DD string to the first of the month (YYYY-MM-01)
function monthStart(raw) {
  if (!raw) return null;
  const m = String(raw).match(/^(\d{4}-\d{2})/);
  return m ? `${m[1]}-01` : null;
}

exports.handler = async (event) => {
  if (!authOk(event)) return json(401, { error: 'Unauthorized' });

  const qp     = event.queryStringParameters || {};
  const method = event.httpMethod;

  try {
    // ── GET: fetch month record + adjustments ────────────────────────────────
    if (method === 'GET') {
      if (!qp.client_id) return json(400, { error: 'client_id required' });
      const month = monthStart(qp.month || new Date().toISOString().slice(0, 7));
      if (!month)         return json(400, { error: 'Invalid month — use YYYY-MM' });

      const monthRes = await sbFetch(
        `/client_billing_months?client_id=eq.${encodeURIComponent(qp.client_id)}&month=eq.${month}&limit=1`
      );
      if (!monthRes.ok) return json(500, { error: await monthRes.text() });
      const months = await monthRes.json();
      const monthRecord = months[0] || null;

      let adjustments = [];
      if (monthRecord) {
        const adjRes = await sbFetch(
          `/client_billing_adjustments?billing_month_id=eq.${monthRecord.id}&order=created_at.asc`
        );
        if (!adjRes.ok) return json(500, { error: await adjRes.text() });
        adjustments = await adjRes.json();
      }

      return json(200, { month_record: monthRecord, adjustments });
    }

    // ── POST: upsert month record OR add adjustment ──────────────────────────
    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');

      // Add adjustment
      if (body.adj) {
        if (!body.billing_month_id || !body.description || body.amount == null) {
          return json(400, { error: 'billing_month_id, description, and amount required' });
        }
        const row = {
          billing_month_id: body.billing_month_id,
          description:      body.description.trim(),
          amount:           parseFloat(body.amount),
          category:         body.category || null,
        };
        const res = await sbFetch('/client_billing_adjustments', { method: 'POST', body: JSON.stringify(row) });
        if (!res.ok) return json(500, { error: await res.text() });
        return json(200, (await res.json())[0]);
      }

      // Upsert month record
      if (!body.client_id || !body.month) return json(400, { error: 'client_id and month required' });
      const month = monthStart(body.month);
      if (!month) return json(400, { error: 'Invalid month' });

      const row = {
        client_id:   body.client_id,
        month,
        status:      body.status   || 'pending',
        notes:       body.notes    || null,
        reviewed_at: body.status === 'reviewed' || body.status === 'invoiced' || body.status === 'paid'
          ? new Date().toISOString()
          : null,
      };
      const res = await sbFetch('/client_billing_months', {
        method:  'POST',
        body:    JSON.stringify(row),
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, (await res.json())[0]);
    }

    // ── PATCH: update an adjustment ──────────────────────────────────────────
    if (method === 'PATCH') {
      if (!qp.adj_id) return json(400, { error: 'adj_id required' });
      const body  = JSON.parse(event.body || '{}');
      const patch = {};
      if ('description' in body) patch.description = body.description.trim();
      if ('amount'      in body) patch.amount       = parseFloat(body.amount);
      if ('category'    in body) patch.category     = body.category || null;
      const res = await sbFetch(
        `/client_billing_adjustments?id=eq.${encodeURIComponent(qp.adj_id)}`,
        { method: 'PATCH', body: JSON.stringify(patch) }
      );
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, (await res.json())[0]);
    }

    // ── DELETE ───────────────────────────────────────────────────────────────
    if (method === 'DELETE') {
      const targetId = qp.adj_id || qp.month_id;
      const table    = qp.adj_id ? 'client_billing_adjustments' : 'client_billing_months';
      if (!targetId) return json(400, { error: 'adj_id or month_id required' });
      const res = await sbFetch(`/${table}?id=eq.${encodeURIComponent(targetId)}`, { method: 'DELETE' });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
