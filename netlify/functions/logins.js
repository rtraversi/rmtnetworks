// Encrypted CRUD for client_logins.
// - Stores passwords as AES-256-GCM ciphertext using SECRETS_KEY (64 hex chars).
// - List endpoints never return plaintext; reveal endpoint returns one password at a time.
// - Auth gate matches verify.js (Bearer token === SESSION_SECRET or KATY_SESSION_SECRET).

const crypto = require('crypto');

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
         (process.env.KATY_SESSION_SECRET && token === process.env.KATY_SESSION_SECRET);
}

function getKey() {
  const hex = process.env.SECRETS_KEY || '';
  if (hex.length !== 64) throw new Error('SECRETS_KEY missing or not 64 hex chars');
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
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
      apikey: process.env.SUPABASE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
}

function maskRow(r) {
  const { password_encrypted, ...rest } = r;
  return { ...rest, has_password: !!password_encrypted };
}

exports.handler = async (event) => {
  if (!authOk(event)) return json(401, { error: 'Unauthorized' });

  const qp = event.queryStringParameters || {};
  const method = event.httpMethod;

  try {
    if (method === 'GET' && qp.reveal) {
      const res = await sbFetch(`/client_logins?id=eq.${encodeURIComponent(qp.reveal)}&select=password_encrypted`);
      if (!res.ok) return json(500, { error: await res.text() });
      const rows = await res.json();
      if (!rows.length) return json(404, { error: 'Not found' });
      return json(200, { password: decrypt(rows[0].password_encrypted) });
    }

    if (method === 'GET') {
      if (!qp.client_id) return json(400, { error: 'client_id required' });
      const res = await sbFetch(`/client_logins?client_id=eq.${encodeURIComponent(qp.client_id)}&order=created_at.asc`);
      if (!res.ok) return json(500, { error: await res.text() });
      const rows = await res.json();
      return json(200, rows.map(maskRow));
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (!body.client_id || !body.app) return json(400, { error: 'client_id and app required' });
      const row = {
        client_id: body.client_id,
        app: body.app,
        username: body.username || null,
        url: body.url || null,
        notes: body.notes || null,
        password_encrypted: body.password ? encrypt(body.password) : null,
      };
      const res = await sbFetch('/client_logins', { method: 'POST', body: JSON.stringify(row) });
      if (!res.ok) return json(500, { error: await res.text() });
      const created = await res.json();
      return json(200, maskRow(created[0]));
    }

    if (method === 'PATCH') {
      if (!qp.id) return json(400, { error: 'id required' });
      const body = JSON.parse(event.body || '{}');
      const patch = {};
      ['app', 'username', 'url', 'notes'].forEach(k => { if (k in body) patch[k] = body[k] || null; });
      if ('password' in body) patch.password_encrypted = body.password ? encrypt(body.password) : null;
      const res = await sbFetch(`/client_logins?id=eq.${encodeURIComponent(qp.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (!res.ok) return json(500, { error: await res.text() });
      const updated = await res.json();
      return json(200, maskRow(updated[0]));
    }

    if (method === 'DELETE') {
      if (!qp.id) return json(400, { error: 'id required' });
      const res = await sbFetch(`/client_logins?id=eq.${encodeURIComponent(qp.id)}`, { method: 'DELETE' });
      if (!res.ok) return json(500, { error: await res.text() });
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
