// /netlify/functions/intake.js
//
// Public, token-authed endpoint behind the "Secure Intake Link" flow.
// No session/password gate — the token itself is the credential, so every
// path re-validates it (not expired, not revoked, uses remaining) before
// touching data. Never exposes SUPABASE_KEY or SECRETS_KEY to the browser;
// intake.html only ever talks to this function.
//
// GET  ?t=TOKEN   -> { label, fields, client_name, is_new_prospect, expires_at }
// POST { token, name, email, phone, company, notes, logins:[...], subscriptions:[...] }
//      -> { ok: true }

const { encrypt } = require('../../lib/secrets.js');
const { sendEmail } = require('../../lib/email-sender.js');

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
      Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
}

async function loadToken(token) {
  if (!token) return null;
  const res = await sbFetch(`/intake_tokens?token=eq.${encodeURIComponent(token)}&select=*,clients(id,name,company)`);
  if (!res.ok) throw new Error(await res.text());
  const rows = await res.json();
  return rows[0] || null;
}

function tokenStatus(row) {
  if (!row) return 'not_found';
  if (row.revoked_at) return 'revoked';
  if (new Date(row.expires_at) < new Date()) return 'expired';
  if (row.use_count >= row.max_uses) return 'used';
  return 'valid';
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'GET') {
      const token = (event.queryStringParameters || {}).t || '';
      const row = await loadToken(token);
      const status = tokenStatus(row);
      if (status !== 'valid') {
        return json(status === 'not_found' ? 404 : 410, { error: linkErrorMessage(status) });
      }
      return json(200, {
        label: row.label || null,
        fields: row.fields || ['contact'],
        client_name: row.clients?.name || row.prospect_name || null,
        company: row.clients?.company || null,
        is_new_prospect: !row.client_id,
        expires_at: row.expires_at,
      });
    }

    if (event.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return json(400, { error: 'Invalid JSON' }); }

      const row = await loadToken(body.token);
      const status = tokenStatus(row);
      if (status !== 'valid') {
        return json(status === 'not_found' ? 404 : 410, { error: linkErrorMessage(status) });
      }

      const allowed = new Set(row.fields || ['contact']);
      const data = {};

      if (allowed.has('contact')) {
        data.contact = {
          name:    clean(body.name),
          email:   clean(body.email),
          phone:   clean(body.phone),
          company: clean(body.company),
        };
      }
      if (allowed.has('logins') && Array.isArray(body.logins)) {
        data.logins = body.logins
          .filter(l => l && clean(l.app))
          .slice(0, 25)
          .map(l => ({
            app: clean(l.app),
            username: clean(l.username),
            url: clean(l.url),
            notes: clean(l.notes),
            password_encrypted: l.password ? encrypt(String(l.password).slice(0, 500)) : null,
          }));
      }
      if (allowed.has('subscriptions') && Array.isArray(body.subscriptions)) {
        data.subscriptions = body.subscriptions
          .filter(s => s && clean(s.service))
          .slice(0, 25)
          .map(s => ({
            service: clean(s.service),
            login: clean(s.login),
            price: s.price ? Number(s.price) || null : null,
            billing_cycle: ['monthly', 'annually', 'payg'].includes(s.billing_cycle) ? s.billing_cycle : 'monthly',
            website_url: clean(s.website_url),
            notes: clean(s.notes),
          }));
      }
      if (allowed.has('notes') && clean(body.notes)) {
        data.notes = clean(body.notes).slice(0, 4000);
      }

      if (!Object.keys(data).length) return json(400, { error: 'Nothing submitted.' });

      const insertRes = await sbFetch('/intake_submissions', {
        method: 'POST',
        body: JSON.stringify({
          token_id: row.id,
          client_id: row.client_id,
          submitted_by_name: data.contact?.name || row.prospect_name || null,
          submitted_by_email: data.contact?.email || null,
          data,
        }),
      });
      if (!insertRes.ok) return json(500, { error: await insertRes.text() });

      await sbFetch(`/intake_tokens?id=eq.${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ use_count: row.use_count + 1 }),
      });

      const notifyTo = process.env.INTAKE_NOTIFY_EMAIL || process.env.ZOHO_FROM_ADDRESS || process.env.ZOHO_SMTP_USER;
      if (notifyTo) {
        try {
          const who = data.contact?.name || row.prospect_name || row.clients?.name || 'Someone';
          await sendEmail({
            to: notifyTo,
            subject: `New intake submission — ${who}`,
            text: `${who} submitted a secure intake form.\n\nReview it in the Clients app under ${row.clients?.name || '(new prospect)'} → Logins & Subscriptions.`,
          });
        } catch (e) {
          console.error('[intake] notify email failed:', e.message);
        }
      }

      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    console.error('[intake] error:', e.message);
    return json(500, { error: 'Unexpected error' });
  }
};

function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, 300) : null;
}

function linkErrorMessage(status) {
  switch (status) {
    case 'expired': return 'This link has expired.';
    case 'used':     return 'This link has already been used.';
    case 'revoked':  return 'This link is no longer active.';
    default:         return 'This link is invalid.';
  }
}
