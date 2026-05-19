// /netlify/functions/render-deed.js
//
// Accepts a DeedRecord-shaped JSON object, returns the rendered PDF binary.
// Content-Type: application/pdf

const { renderDeedPdf } = require('../../lib/deed-renderer');

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST required' });
  if (!authOk(event)) return json(401, { error: 'Unauthorized' });

  let deed;
  try { deed = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }); }

  if (!deed || !deed.grantor_name || !deed.grantee_name) {
    return json(400, { error: 'deed.grantor_name and deed.grantee_name are required' });
  }

  try {
    const bytes = await renderDeedPdf(deed);
    // Netlify expects base64 body when isBase64Encoded is true.
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="new-deed.pdf"`,
        'Cache-Control': 'no-store',
      },
      body: Buffer.from(bytes).toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e) {
    return json(500, { error: e.message });
  }
};
