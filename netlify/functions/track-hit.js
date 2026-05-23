// Increments a hit counter in Supabase.
// Pass ?metric=page_hits (default) or other metric names to track different pages.
exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS };

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;

  const metric  = event.queryStringParameters?.metric || 'page_hits';
  const allowed = ['page_hits', 'proof_scan_hits', 'uscis_hits', 'portal_demo_hits'];
  if (!allowed.includes(metric)) return { statusCode: 400, headers: CORS, body: 'Invalid metric' };

  try {
    const getRes = await fetch(
      `${SB_URL}/rest/v1/usage_metrics?service_name=eq.Demo&metric_name=eq.${metric}&select=used_value`,
      { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
    );
    const rows = await getRes.json();
    const current = rows[0]?.used_value ?? 0;

    const patchRes = await fetch(
      `${SB_URL}/rest/v1/usage_metrics?service_name=eq.Demo&metric_name=eq.${metric}`,
      {
        method: 'PATCH',
        headers: {
          'apikey':        SB_KEY,
          'Authorization': `Bearer ${SB_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=minimal',
        },
        body: JSON.stringify({ used_value: current + 1, last_updated: new Date().toISOString() }),
      }
    );

    if (!patchRes.ok) throw new Error(`PATCH failed: ${await patchRes.text()}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...CORS },
      body: JSON.stringify({ hits: current + 1 }),
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: e.message };
  }
};
