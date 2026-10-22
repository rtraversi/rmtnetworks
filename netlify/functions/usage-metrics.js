// Read-only `usage_metrics` (tracker.html usage column, portal.html hit counters).
// Rob/Katy only. Writes stay in fetch-usage / track-hit.
//
// GET                        → all metrics, by service then metric
// GET ?service_name=<name>   → one service's metrics

'use strict';

const { whoAmI, isMax } = require('../../lib/max-scope.js');

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (!whoAmI(event) || isMax(event)) return json(401, { error: 'Unauthorized' });
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const qp = event.queryStringParameters || {};
  const filter = qp.service_name ? `&service_name=eq.${encodeURIComponent(qp.service_name)}` : '';

  try {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/usage_metrics?select=*&order=service_name.asc,metric_name.asc${filter}`,
      { headers: { apikey: process.env.SUPABASE_KEY } }
    );
    if (!res.ok) return json(500, { error: await res.text() });
    return json(200, await res.json());
  } catch (e) {
    return json(500, { error: e.message });
  }
};
