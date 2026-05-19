// /netlify/functions/list-deeds.js
//
// Returns the available "new deed" records for the dropdown in the demo UI.
// Backend selection is in /lib/deed-source.js (env DEED_SOURCE).

const { listDeeds, currentSource } = require('../../lib/deed-source');

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
  if (!authOk(event)) return json(401, { error: 'Unauthorized' });
  try {
    const deeds = await listDeeds();
    return json(200, { source: currentSource(), deeds });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
