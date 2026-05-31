// anthropic-usage.js — Rob-only Anthropic workspace cost summary per client.
//
// GET /.netlify/functions/anthropic-usage?client=<slug>
//     Authorization: Bearer <Rob session token>
//
// Returns current-month spend from the Anthropic cost_report API, broken
// down by model. Amount values from Anthropic are in cents (decimal string).

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
  if (!token || !process.env.SESSION_SECRET) return false;
  return token === process.env.SESSION_SECRET;
}

// Add new clients here as you set up their workspaces.
const KEY_MAP = {
  adriana: 'ANTHROPIC_ADMIN_KEY_ADRIANA',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS };
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  if (!isRob(event.headers.authorization || event.headers.Authorization)) {
    return json(401, { error: 'Unauthorized' });
  }

  const client = (event.queryStringParameters?.client || '').toLowerCase().trim();
  if (!client) return json(400, { error: 'client param required' });

  const envKey = KEY_MAP[client];
  if (!envKey) return json(404, { error: `No Anthropic config for client: ${client}` });

  const adminKey = process.env[envKey];
  if (!adminKey) return json(503, { error: `${envKey} not configured in Netlify env vars` });

  // Current month window
  const now        = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const tomorrow   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

  const startingAt = monthStart.toISOString().replace('.000Z', 'Z');
  const endingAt   = tomorrow.toISOString().replace('.000Z', 'Z');

  try {
    const url = new URL('https://api.anthropic.com/v1/organizations/cost_report');
    url.searchParams.set('starting_at', startingAt);
    url.searchParams.set('ending_at',   endingAt);
    url.searchParams.append('group_by[]', 'model');
    url.searchParams.set('bucket_width', '1d');

    const res = await fetch(url.toString(), {
      headers: {
        'x-api-key':          adminKey,
        'anthropic-version':  '2023-06-01',
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      return json(res.status, { error: `Anthropic API: ${errText}` });
    }

    const data = await res.json();

    // Aggregate cents by model across all daily buckets
    const modelTotals = {};
    let totalCents = 0;

    for (const bucket of (data.data || [])) {
      for (const result of (bucket.results || [])) {
        const cents = parseFloat(result.amount || 0);
        totalCents += cents;
        const model = result.model || 'unknown';
        modelTotals[model] = (modelTotals[model] || 0) + cents;
      }
    }

    const breakdown = Object.entries(modelTotals)
      .map(([model, cents]) => ({ model, cents, dollars: cents / 100 }))
      .sort((a, b) => b.cents - a.cents);

    return json(200, {
      client,
      period:        { starting_at: startingAt, ending_at: endingAt },
      total_cents:   totalCents,
      total_dollars: totalCents / 100,
      breakdown,
      generated_at:  new Date().toISOString(),
    });
  } catch (err) {
    console.error('anthropic-usage error:', err);
    return json(500, { error: err.message || 'Failed to fetch Anthropic usage' });
  }
};
