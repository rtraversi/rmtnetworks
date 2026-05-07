// Called by GitHub Actions cron 2x daily to update usage metrics in Supabase.
// Auth: Authorization: Bearer <CRON_SECRET>
exports.handler = async (event) => {
  const auth  = (event.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (!process.env.CRON_SECRET || auth !== process.env.CRON_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;
  const results = [];

  async function patchMetric(service, metric, usedValue) {
    const url = `${SB_URL}/rest/v1/usage_metrics`
      + `?service_name=eq.${encodeURIComponent(service)}`
      + `&metric_name=eq.${encodeURIComponent(metric)}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ used_value: usedValue, last_updated: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`Supabase PATCH failed (${res.status}): ${await res.text()}`);
  }

  // ── 1. Cloudinary ──────────────────────────────────────────────────────────
  if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    try {
      const creds = Buffer.from(`${process.env.CLOUDINARY_API_KEY}:${process.env.CLOUDINARY_API_SECRET}`).toString('base64');
      const res   = await fetch(`https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/usage`, {
        headers: { 'Authorization': `Basic ${creds}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();

      // credits.usage is the Cloudinary credit figure (1 credit = 1 GB managed storage)
      const credits    = d.credits?.usage    ?? (d.storage?.usage / 1073741824);
      const adminCalls = d.requests          ?? 0;

      await patchMetric('Cloudinary', 'credits',   Math.round(credits * 1000) / 1000);
      await patchMetric('Cloudinary', 'admin_api', adminCalls);
      results.push({ service: 'Cloudinary', ok: true, credits, adminCalls });
    } catch (e) {
      results.push({ service: 'Cloudinary', ok: false, error: e.message });
    }
  } else {
    results.push({ service: 'Cloudinary', ok: null, reason: 'Missing env vars' });
  }

  // ── 2. Supabase DB size (via RPC created in migration) ────────────────────
  try {
    const res = await fetch(`${SB_URL}/rest/v1/rpc/get_db_size_mb`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const mb = await res.json();
    await patchMetric('Supabase', 'db_size_mb', mb);
    results.push({ service: 'Supabase', ok: true, db_size_mb: mb });
  } catch (e) {
    results.push({ service: 'Supabase', ok: false, error: e.message });
  }

  // ── 3. Make operations (best-effort — API coverage not guaranteed) ─────────
  if (process.env.MAKE_API_TOKEN) {
    try {
      const region  = process.env.MAKE_API_REGION || 'us2';
      const baseUrl = `https://${region}.make.com/api/v2`;

      const makeHeaders = {
        'Authorization': `Token ${process.env.MAKE_API_TOKEN}`,
        'Content-Type': 'application/json',
      };

      const meRes = await fetch(`${baseUrl}/users/me`, { headers: makeHeaders });
      if (!meRes.ok) {
        const body = await meRes.text();
        throw new Error(`/users/me HTTP ${meRes.status}: ${body}`);
      }
      const me    = await meRes.json();
      const orgId = me.user?.organizationId
        ?? me.user?.organization?.id
        ?? me.authUser?.organizationId
        ?? me.authUser?.organization?.id;

      if (!orgId) {
        // Fall back: fetch org list directly
        const orgsRes = await fetch(`${baseUrl}/organizations`, { headers: makeHeaders });
        if (!orgsRes.ok) throw new Error('Could not get org ID. /users/me: ' + JSON.stringify(me));
        const orgsData = await orgsRes.json();
        const firstOrg = orgsData.organizations?.[0] ?? orgsData[0];
        if (!firstOrg?.id) throw new Error('No org found. /users/me: ' + JSON.stringify(me));
        // recurse with found org
        const orgRes2 = await fetch(`${baseUrl}/organizations/${firstOrg.id}`, { headers: makeHeaders });
        if (!orgRes2.ok) throw new Error(`/organizations/${firstOrg.id} HTTP ${orgRes2.status}`);
        const org2 = await orgRes2.json();
        const opsUsed2 = org2.organization?.operations ?? org2.organization?.operationsUsed ?? org2.organization?.operations_used ?? org2.organization?.plan?.operationsUsed ?? org2.operations;
        if (opsUsed2 != null) {
          await patchMetric('Make', 'operations', opsUsed2);
          results.push({ service: 'Make', ok: true, operations: opsUsed2 });
        } else {
          results.push({ service: 'Make', ok: null, note: 'ops field not found', orgKeys: Object.keys(org2.organization || org2) });
        }
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updated: new Date().toISOString(), results }, null, 2) };
      }

      const orgRes = await fetch(`${baseUrl}/organizations/${orgId}`, { headers: makeHeaders });
      if (!orgRes.ok) throw new Error(`/organizations/${orgId} HTTP ${orgRes.status}`);
      const org     = await orgRes.json();
      const opsUsed = org.organization?.operations
        ?? org.organization?.operationsUsed
        ?? org.organization?.operations_used
        ?? org.organization?.plan?.operationsUsed;

      if (opsUsed != null) {
        await patchMetric('Make', 'operations', opsUsed);
        results.push({ service: 'Make', ok: true, operations: opsUsed });
      } else {
        // Log full response so we can see what fields are available
        results.push({ service: 'Make', ok: null, note: 'operations field not found', orgKeys: Object.keys(org.organization || org) });
      }
    } catch (e) {
      results.push({ service: 'Make', ok: false, error: e.message });
    }
  } else {
    results.push({ service: 'Make', ok: null, reason: 'MAKE_API_TOKEN not set' });
  }

  // ── 4. Netlify build credits (best-effort) ────────────────────────────────
  if (process.env.NETLIFY_TOKEN && process.env.NETLIFY_ACCOUNT_SLUG) {
    try {
      const res = await fetch(`https://api.netlify.com/api/v1/accounts/${process.env.NETLIFY_ACCOUNT_SLUG}`, {
        headers: { 'Authorization': `Bearer ${process.env.NETLIFY_TOKEN}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();

      // Field names are undocumented — log so we can find the right one
      const creditsUsed = d.credits_used
        ?? d.billing?.credits_used
        ?? d.subscription?.credits_used
        ?? d.capabilities?.buildCreditsUsed
        ?? d.plan_credits;

      if (creditsUsed != null) {
        await patchMetric('Netlify', 'credits', creditsUsed);
        results.push({
          service: 'Netlify',
          ok: true,
          credits: creditsUsed,
          plan_credits: d.plan_credits,
          capabilitiesKeys: d.capabilities ? Object.keys(d.capabilities) : 'no capabilities object',
          capabilitiesValues: d.capabilities,
        });
      } else {
        results.push({ service: 'Netlify', ok: null, note: 'credits field not found', topKeys: Object.keys(d), capabilitiesValues: d.capabilities });
      }
    } catch (e) {
      results.push({ service: 'Netlify', ok: false, error: e.message });
    }
  } else {
    results.push({ service: 'Netlify', ok: null, reason: 'NETLIFY_TOKEN or NETLIFY_ACCOUNT_SLUG not set' });
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updated: new Date().toISOString(), results }, null, 2),
  };
};
