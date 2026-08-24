// Increments a hit counter in Supabase.
// Pass ?metric=page_hits (default) or other metric names to track different pages.
//
// iurix_v1_hits / iurix_v2_hits are the two iurixaccreditation.com landing
// variants Katy is comparing (?v=1 vs ?v=2). They are counted here rather than
// in Cloudflare Web Analytics because CF groups pageviews by request PATH and
// discards the query string — which is the only thing telling the two variants
// apart. The beacon lives in the attytraining repo (app/_components/hit-beacon.tsx).
exports.handler = async (event) => {
  const CORS = {
    // The iurix beacon posts from https://iurixaccreditation.com, so this stays '*'.
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS };

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;

  const metric  = event.queryStringParameters?.metric || 'page_hits';
  const allowed = ['page_hits', 'proof_scan_hits', 'uscis_hits', 'iurix_v1_hits', 'iurix_v2_hits'];
  if (!allowed.includes(metric)) return { statusCode: 400, headers: CORS, body: 'Invalid metric' };

  // Only used when the row has to be created on first hit.
  const LABELS = {
    page_hits:       'Tracker Demo',
    proof_scan_hits: 'Proof Scan',
    uscis_hits:      'USCIS Intake',
    iurix_v1_hits:   'IURIX landing v1',
    iurix_v2_hits:   'IURIX landing v2',
  };

  try {
    const headers = { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` };

    const getRes = await fetch(
      `${SB_URL}/rest/v1/usage_metrics?service_name=eq.Demo&metric_name=eq.${metric}&select=used_value`,
      { headers }
    );
    const rows = await getRes.json();

    // A new metric has no row yet, and PATCH against a missing row is a silent
    // no-op that still returns 200 — the counter would read zero forever with
    // nothing to show for it. So create the row on the first hit instead of
    // requiring someone to remember to seed it by hand.
    if (!rows[0]) {
      const insRes = await fetch(`${SB_URL}/rest/v1/usage_metrics`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          service_name: 'Demo',
          metric_name:  metric,
          metric_label: LABELS[metric] || metric,
          used_value:   1,
          last_updated: new Date().toISOString(),
        }),
      });
      if (!insRes.ok) throw new Error(`INSERT failed: ${await insRes.text()}`);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...CORS },
        body: JSON.stringify({ hits: 1 }),
      };
    }

    const current = rows[0].used_value ?? 0;

    const patchRes = await fetch(
      `${SB_URL}/rest/v1/usage_metrics?service_name=eq.Demo&metric_name=eq.${metric}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
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
