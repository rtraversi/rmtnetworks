// integrations.js — Encrypted CRUD for client_integrations (per-client service credentials).
// Mirrors the pattern in logins.js: values are never returned in plaintext on list,
// only revealed one at a time via ?reveal=<id>.
//
// GET  ?client_id=<uuid>&service=<name>   → list credentials for client (values masked)
// GET  ?reveal=<uuid>                     → return one decrypted value
// POST body { client_id, service, key_name, value, enabled?, notes? }  → upsert credential
// PATCH ?id=<uuid> body { value?, enabled?, notes? }                   → update
// DELETE ?id=<uuid>                                                    → remove

const crypto = require('crypto');

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

function getKey() {
  const hex = process.env.SECRETS_KEY || '';
  if (hex.length !== 64) throw new Error('SECRETS_KEY missing or not 64 hex chars');
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc    = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return `${iv.toString('hex')}:${enc.toString('hex')}:${tag.toString('hex')}`;
}

function decrypt(blob) {
  if (!blob) return '';
  const [ivHex, dataHex, tagHex] = String(blob).split(':');
  if (!ivHex || !dataHex || !tagHex) throw new Error('Malformed ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

function sbFetch(path, opts = {}) {
  return fetch(process.env.SUPABASE_URL + '/rest/v1' + path, {
    ...opts,
    headers: {
      apikey:           process.env.SUPABASE_KEY,
      Authorization:    `Bearer ${process.env.SUPABASE_KEY}`,
      'Content-Type':   'application/json',
      Prefer:           'return=representation',
      ...(opts.headers || {}),
    },
  });
}

function maskRow(r) {
  const { value_encrypted, ...rest } = r;
  return { ...rest, has_value: !!value_encrypted };
}

exports.handler = async (event) => {
  if (!authOk(event)) return json(401, { error: 'Unauthorized' });

  const qp     = event.queryStringParameters || {};
  const method = event.httpMethod;

  try {
    // Reveal one decrypted value
    if (method === 'GET' && qp.reveal) {
      const res = await sbFetch(`/client_integrations?id=eq.${encodeURIComponent(qp.reveal)}&select=value_encrypted`);
      if (!res.ok) return json(500, { error: await res.text() });
      const rows = await res.json();
      if (!rows.length) return json(404, { error: 'Not found' });
      return json(200, { value: decrypt(rows[0].value_encrypted) });
    }

    // List credentials for a client (optionally filtered by service)
    if (method === 'GET') {
      if (!qp.client_id) return json(400, { error: 'client_id required' });
      let url = `/client_integrations?client_id=eq.${encodeURIComponent(qp.client_id)}&order=service.asc,key_name.asc`;
      if (qp.service) url += `&service=eq.${encodeURIComponent(qp.service)}`;
      const res = await sbFetch(url);
      if (!res.ok) return json(500, { error: await res.text() });
      const rows = await res.json();
      return json(200, rows.map(maskRow));
    }

    // Upsert (insert or update by client_id+service+key_name)
    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (!body.client_id || !body.service || !body.key_name) {
        return json(400, { error: 'client_id, service, and key_name required' });
      }
      const row = {
        client_id:       body.client_id,
        service:         body.service,
        key_name:        body.key_name,
        value_encrypted: body.value ? encrypt(body.value) : null,
        enabled:         body.enabled !== false,
        notes:           body.notes || null,
        updated_at:      new Date().toISOString(),
      };
      const res = await sbFetch('/client_integrations', {
        method:  'POST',
        body:    JSON.stringify(row),
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      });
      if (!res.ok) return json(500, { error: await res.text() });
      const created = await res.json();
      return json(200, maskRow(created[0]));
    }

    // Patch a single row by id
    if (method === 'PATCH') {
      if (!qp.id) return json(400, { error: 'id required' });
      const body  = JSON.parse(event.body || '{}');
      const patch = { updated_at: new Date().toISOString() };
      if ('enabled' in body) patch.enabled = !!body.enabled;
      if ('notes'   in body) patch.notes   = body.notes || null;
      if ('value'   in body) patch.value_encrypted = body.value ? encrypt(body.value) : null;
      const res = await sbFetch(`/client_integrations?id=eq.${encodeURIComponent(qp.id)}`, {
        method: 'PATCH',
        body:   JSON.stringify(patch),
      });
      if (!res.ok) return json(500, { error: await res.text() });
      const updated = await res.json();
      return json(200, maskRow(updated[0]));
    }

    // Delete a single row by id
    if (method === 'DELETE') {
      if (!qp.id) return json(400, { error: 'id required' });
      const res = await sbFetch(`/client_integrations?id=eq.${encodeURIComponent(qp.id)}`, { method: 'DELETE' });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
