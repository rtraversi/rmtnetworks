// /netlify/functions/extract-deed.js
//
// Accepts an uploaded deed (PDF or image) as base64, calls Claude vision
// extraction, returns DeedRecord-shaped JSON.
//
// Request body (JSON):
//   { base64: "<no data URI prefix>", mediaType: "application/pdf" | "image/jpeg" | "image/png" }
//
// Response: { ok: true, fields: { ...deed... } }

const { extractDeedFields } = require('../../lib/deed-extractor');

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

const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
  if (!authOk(event)) return json(401, { error: 'Unauthorized' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }); }

  const { base64, mediaType } = body;
  if (!base64) return json(400, { error: 'base64 required' });
  if (!mediaType || !ALLOWED_TYPES.has(mediaType)) {
    return json(400, { error: `mediaType must be one of ${Array.from(ALLOWED_TYPES).join(', ')}` });
  }

  // Strip a "data:...;base64," prefix if the client forgot to remove it.
  const cleaned = String(base64).replace(/^data:[^;]+;base64,/, '');

  try {
    const fields = await extractDeedFields({ base64: cleaned, mediaType });
    return json(200, { ok: true, fields });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
