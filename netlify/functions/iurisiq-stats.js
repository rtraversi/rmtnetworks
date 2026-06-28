// iurisiq-stats.js — Rob-only IurisIQ demo portal analytics for the portal tile.
//
// GET  Authorization: Bearer <rmt session token (Rob only)>
//
// Proxies to the IurisIQ demo Worker's /api/demo-stats endpoint and returns:
//   visitors_today, logins_7d, sessions_7d, top_module, avg_session_minutes, demo_url
//
// Required Netlify env vars:
//   IURISIQ_DEMO_URL          — demo Worker base URL (e.g. https://iurisiq-demo.workers.dev)
//   IURISIQ_DEMO_STATS_TOKEN  — bearer token matching DEMO_STATS_TOKEN secret on the Worker

'use strict';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const json = (status, body) => ({
  statusCode: status,
  headers: { ...CORS, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function isRob(authHeader) {
  const token = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  if (!process.env.SESSION_SECRET) return false;
  return token === process.env.SESSION_SECRET;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS };
  if (event.httpMethod !== 'GET')     return json(405, { error: 'Method not allowed' });

  if (!isRob(event.headers.authorization || event.headers.Authorization)) {
    return json(401, { error: 'Unauthorized' });
  }

  const demoUrl   = process.env.IURISIQ_DEMO_URL;
  const demoToken = process.env.IURISIQ_DEMO_STATS_TOKEN;

  if (!demoUrl || !demoToken) {
    return json(503, {
      error: 'Demo portal not configured',
      hint:  'Set IURISIQ_DEMO_URL and IURISIQ_DEMO_STATS_TOKEN in Netlify env vars.',
    });
  }

  try {
    const r = await fetch(`${demoUrl}/api/demo-stats`, {
      headers: { 'Authorization': `Bearer ${demoToken}` },
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return json(502, { error: `Demo Worker returned ${r.status}`, detail: body });
    }
    const data = await r.json();
    return json(200, { ...data, demo_url: demoUrl });
  } catch (err) {
    return json(500, { error: err.message || 'Failed to reach demo Worker' });
  }
};
