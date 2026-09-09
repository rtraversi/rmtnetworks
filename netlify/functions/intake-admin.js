// /netlify/functions/intake-admin.js
//
// Staff-side management of Secure Intake Links: generate a token, list links
// and pending submissions for a client, review a submission (decrypted), and
// apply a reviewed submission into client_logins / client_subscriptions /
// clients. Auth gate matches logins.js (Bearer token === one of the shared
// session secrets).
//
// POST body { client_id?, prospect_name?, fields:[...], expires_in_days, max_uses?, label? }
//   -> create a token, returns the row including the plaintext token (shown once)
// GET  ?client_id=xxx        -> { tokens:[...], submissions:[...] } for that client
// GET  ?submission_id=xxx    -> single submission, logins decrypted for review
// PATCH ?apply_submission=xxx -> writes the submission into real tables
// PATCH ?dismiss_submission=xxx -> marks a submission dismissed, no writes
// DELETE ?revoke_token=xxx   -> revokes a token early

const crypto = require('crypto');
const { encrypt, decrypt } = require('../../lib/secrets.js');

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function whoAmI(event) {
  const raw = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  if (process.env.SESSION_SECRET && token === process.env.SESSION_SECRET) return 'Rob';
  if (process.env.KATY_SESSION_SECRET && token === process.env.KATY_SESSION_SECRET) return 'Katy';
  if (process.env.MAX_SESSION_SECRET && token === process.env.MAX_SESSION_SECRET) return 'Max';
  return null;
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

const VALID_FIELDS = ['contact', 'logins', 'subscriptions', 'notes'];

function tokenStatus(row) {
  if (row.revoked_at) return 'revoked';
  if (new Date(row.expires_at) < new Date()) return 'expired';
  if (row.use_count >= row.max_uses) return 'used';
  return 'active';
}

exports.handler = async (event) => {
  const who = whoAmI(event);
  if (!who) return json(401, { error: 'Unauthorized' });

  const qp = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const fields = Array.isArray(body.fields) ? body.fields.filter(f => VALID_FIELDS.includes(f)) : ['contact'];
      if (!fields.length) return json(400, { error: 'At least one field section required' });
      if (!body.client_id && !body.prospect_name) return json(400, { error: 'client_id or prospect_name required' });

      const days = Number(body.expires_in_days) > 0 ? Number(body.expires_in_days) : 7;
      const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
      const token = crypto.randomBytes(32).toString('base64url');

      const res = await sbFetch('/intake_tokens', {
        method: 'POST',
        body: JSON.stringify({
          client_id: body.client_id || null,
          prospect_name: body.client_id ? null : String(body.prospect_name).trim().slice(0, 200),
          token,
          label: body.label ? String(body.label).trim().slice(0, 200) : null,
          message: body.message ? String(body.message).trim().slice(0, 1000) : null,
          fields,
          expires_at: expiresAt,
          max_uses: Number(body.max_uses) > 0 ? Math.min(Number(body.max_uses), 50) : 1,
          created_by: who,
        }),
      });
      if (!res.ok) return json(500, { error: await res.text() });
      const [created] = await res.json();
      return json(200, created);
    }

    if (event.httpMethod === 'GET' && qp.submission_id) {
      const res = await sbFetch(`/intake_submissions?id=eq.${encodeURIComponent(qp.submission_id)}&select=*`);
      if (!res.ok) return json(500, { error: await res.text() });
      const [row] = await res.json();
      if (!row) return json(404, { error: 'Not found' });
      const decrypted = { ...row, data: { ...row.data } };
      if (decrypted.data.logins) {
        decrypted.data.logins = decrypted.data.logins.map(l => ({
          ...l,
          password: l.password_encrypted ? decrypt(l.password_encrypted) : null,
          password_encrypted: undefined,
        }));
      }
      return json(200, decrypted);
    }

    if (event.httpMethod === 'GET') {
      if (!qp.client_id) return json(400, { error: 'client_id required' });
      const [tokRes, subRes] = await Promise.all([
        sbFetch(`/intake_tokens?client_id=eq.${encodeURIComponent(qp.client_id)}&order=created_at.desc`),
        sbFetch(`/intake_submissions?client_id=eq.${encodeURIComponent(qp.client_id)}&status=eq.pending&order=created_at.desc`),
      ]);
      if (!tokRes.ok) return json(500, { error: await tokRes.text() });
      if (!subRes.ok) return json(500, { error: await subRes.text() });
      const tokens = (await tokRes.json()).map(t => ({ ...t, token: undefined, status: tokenStatus(t) }));
      const submissions = await subRes.json();
      return json(200, { tokens, submissions });
    }

    if (event.httpMethod === 'PATCH' && qp.dismiss_submission) {
      const res = await sbFetch(`/intake_submissions?id=eq.${encodeURIComponent(qp.dismiss_submission)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'dismissed' }),
      });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, { ok: true });
    }

    if (event.httpMethod === 'PATCH' && qp.apply_submission) {
      return await applySubmission(qp.apply_submission, who);
    }

    if (event.httpMethod === 'DELETE' && qp.revoke_token) {
      const res = await sbFetch(`/intake_tokens?id=eq.${encodeURIComponent(qp.revoke_token)}`, {
        method: 'PATCH',
        body: JSON.stringify({ revoked_at: new Date().toISOString() }),
      });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    console.error('[intake-admin] error:', e.message);
    return json(500, { error: e.message });
  }
};

async function applySubmission(submissionId, who) {
  const subRes = await sbFetch(`/intake_submissions?id=eq.${encodeURIComponent(submissionId)}&select=*`);
  if (!subRes.ok) return json(500, { error: await subRes.text() });
  const [sub] = await subRes.json();
  if (!sub) return json(404, { error: 'Not found' });
  if (sub.status !== 'pending') return json(409, { error: `Submission is already ${sub.status}` });

  let clientId = sub.client_id;

  if (!clientId) {
    const c = sub.data.contact || {};
    const created = await sbFetch('/clients', {
      method: 'POST',
      body: JSON.stringify({
        name: c.name || sub.submitted_by_name || 'New Prospect',
        company: c.company || null,
        email: c.email || null,
        phone: c.phone || null,
        status: 'prospect',
      }),
    });
    if (!created.ok) return json(500, { error: await created.text() });
    const [newClient] = await created.json();
    clientId = newClient.id;
  } else if (sub.data.contact) {
    // Fill in blanks only — never clobber existing client data with intake input.
    const cRes = await sbFetch(`/clients?id=eq.${clientId}&select=email,phone,company`);
    if (cRes.ok) {
      const [existing] = await cRes.json();
      const patch = {};
      const c = sub.data.contact;
      if (!existing?.email && c.email) patch.email = c.email;
      if (!existing?.phone && c.phone) patch.phone = c.phone;
      if (!existing?.company && c.company) patch.company = c.company;
      if (Object.keys(patch).length) {
        await sbFetch(`/clients?id=eq.${clientId}`, { method: 'PATCH', body: JSON.stringify(patch) });
      }
    }
  }

  if (Array.isArray(sub.data.logins) && sub.data.logins.length) {
    const rows = sub.data.logins.map(l => ({
      client_id: clientId,
      app: l.app,
      username: l.username || null,
      url: l.url || null,
      notes: l.notes || null,
      password_encrypted: l.password_encrypted || null, // already ciphertext — do not re-encrypt
      category: null,
    }));
    const res = await sbFetch('/client_logins', { method: 'POST', body: JSON.stringify(rows) });
    if (!res.ok) return json(500, { error: 'Applied client but failed on logins: ' + await res.text() });
  }

  if (Array.isArray(sub.data.subscriptions) && sub.data.subscriptions.length) {
    const rows = sub.data.subscriptions.map(s => ({
      client_id: clientId,
      service: s.service,
      login: s.login || null,
      price: s.price ?? null,
      billing_cycle: s.billing_cycle || 'monthly',
      website_url: s.website_url || null,
      notes: s.notes || null,
    }));
    const res = await sbFetch('/client_subscriptions', { method: 'POST', body: JSON.stringify(rows) });
    if (!res.ok) return json(500, { error: 'Applied client but failed on subscriptions: ' + await res.text() });
  }

  if (sub.data.notes) {
    const cRes = await sbFetch(`/clients?id=eq.${clientId}&select=notes`);
    if (cRes.ok) {
      const [existing] = await cRes.json();
      const merged = [existing?.notes, `[Intake ${new Date().toISOString().slice(0, 10)}] ${sub.data.notes}`].filter(Boolean).join('\n\n');
      await sbFetch(`/clients?id=eq.${clientId}`, { method: 'PATCH', body: JSON.stringify({ notes: merged }) });
    }
  }

  await sbFetch(`/intake_submissions?id=eq.${submissionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'applied', applied_at: new Date().toISOString(), applied_by: who }),
  });

  return json(200, { ok: true, client_id: clientId });
}
