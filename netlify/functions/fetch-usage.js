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

  async function patchMetric(service, metric, usedValue, clientId = null) {
    let url = `${SB_URL}/rest/v1/usage_metrics`
      + `?service_name=eq.${encodeURIComponent(service)}`
      + `&metric_name=eq.${encodeURIComponent(metric)}`;
    if (clientId) url += `&client_id=eq.${encodeURIComponent(clientId)}`;
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

  // Client config — one entry per managed client.
  // Env var names use the client slug as prefix (e.g. SFL_CF_ACCOUNT_ID).
  // Add a new entry here when onboarding a client with R2/B2 monitoring.
  const CLIENTS = [
    {
      slug: 'SFL',
      id:   'f2e8af49-2211-443f-9349-4615185e1d53',
      r2: { accountId: 'SFL_CF_ACCOUNT_ID', apiToken: 'SFL_CF_API_TOKEN', bucket: 'SFL_CF_R2_BUCKET' },
      b2: { appKeyId:  'SFL_B2_APP_KEY_ID',  appKey:   'SFL_B2_APP_KEY',   bucket: 'SFL_B2_BUCKET_NAME' },
    },
  ];

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
      } else {
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
          results.push({ service: 'Make', ok: null, note: 'operations field not found', orgKeys: Object.keys(org.organization || org) });
        }
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
      const creditsUsed = d.capabilities?.credits?.used ?? null;
      const creditsTotal = d.capabilities?.credits?.included ?? d.plan_credits ?? null;

      if (creditsUsed != null) {
        await patchMetric('Netlify', 'credits', creditsUsed);
        results.push({ service: 'Netlify', ok: true, credits_used: creditsUsed, credits_total: creditsTotal, note: 'credits.used always 0 — API limitation, scraping needed for real value' });
      } else {
        results.push({ service: 'Netlify', ok: null, note: 'credits field not found' });
      }
    } catch (e) {
      results.push({ service: 'Netlify', ok: false, error: e.message });
    }
  } else {
    results.push({ service: 'Netlify', ok: null, reason: 'NETLIFY_TOKEN or NETLIFY_ACCOUNT_SLUG not set' });
  }

  // ── 5 & 6. Per-client infrastructure (R2 + B2) ───────────────────────────
  for (const client of CLIENTS) {
    // Cloudflare R2
    const r2 = client.r2;
    if (process.env[r2.accountId] && process.env[r2.apiToken] && process.env[r2.bucket]) {
      try {
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(process.env[r2.accountId])}/r2/buckets/${encodeURIComponent(process.env[r2.bucket])}/usage`,
          { headers: { 'Authorization': `Bearer ${process.env[r2.apiToken]}` } }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        const d     = await res.json();
        const usage = d.result ?? d;
        const bytes = (usage.payloadSize ?? 0) + (usage.metadataSize ?? 0);
        const gb    = Math.round((bytes / 1073741824) * 1000) / 1000;
        const objs  = usage.objectCount ?? 0;

        await patchMetric('Cloudflare R2', 'storage_gb',   gb,   client.id);
        await patchMetric('Cloudflare R2', 'object_count', objs, client.id);
        results.push({ client: client.slug, service: 'Cloudflare R2', ok: true, storage_gb: gb, object_count: objs });
      } catch (e) {
        results.push({ client: client.slug, service: 'Cloudflare R2', ok: false, error: e.message });
      }
    } else {
      results.push({ client: client.slug, service: 'Cloudflare R2', ok: null, reason: `Missing ${r2.accountId}, ${r2.apiToken}, or ${r2.bucket}` });
    }

    // Backblaze B2 — no storage-size endpoint; check last uploaded file as backup health signal
    const b2 = client.b2;
    if (process.env[b2.appKeyId] && process.env[b2.appKey] && process.env[b2.bucket]) {
      try {
        const creds   = Buffer.from(`${process.env[b2.appKeyId]}:${process.env[b2.appKey]}`).toString('base64');
        const authRes = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
          headers: { 'Authorization': `Basic ${creds}` },
        });
        if (!authRes.ok) throw new Error(`Auth HTTP ${authRes.status}`);
        const auth   = await authRes.json();
        const apiUrl = auth.apiInfo?.storageApi?.apiUrl ?? auth.apiUrl;
        const token  = auth.authorizationToken;

        const bucketsRes = await fetch(
          `${apiUrl}/b2api/v3/b2_list_buckets?accountId=${encodeURIComponent(auth.accountId)}&bucketName=${encodeURIComponent(process.env[b2.bucket])}`,
          { headers: { 'Authorization': token } }
        );
        if (!bucketsRes.ok) throw new Error(`list_buckets HTTP ${bucketsRes.status}`);
        const bkt = ((await bucketsRes.json()).buckets ?? [])[0];
        if (!bkt) throw new Error(`Bucket "${process.env[b2.bucket]}" not found`);

        const filesRes = await fetch(
          `${apiUrl}/b2api/v3/b2_list_file_names?bucketId=${encodeURIComponent(bkt.bucketId)}&maxFileCount=100`,
          { headers: { 'Authorization': token } }
        );
        if (!filesRes.ok) throw new Error(`list_file_names HTTP ${filesRes.status}`);
        const files = (await filesRes.json()).files ?? [];

        let latestTs = 0, latestName = null;
        for (const f of files) {
          if ((f.uploadTimestamp ?? 0) > latestTs) { latestTs = f.uploadTimestamp; latestName = f.fileName; }
        }

        const lastBackupSec = latestTs ? Math.floor(latestTs / 1000) : 0;
        await patchMetric('Backblaze B2', 'last_backup_ts', lastBackupSec, client.id);
        results.push({ client: client.slug, service: 'Backblaze B2', ok: true, last_backup: latestTs ? new Date(latestTs).toISOString() : null, last_file: latestName, files_sampled: files.length });
      } catch (e) {
        results.push({ client: client.slug, service: 'Backblaze B2', ok: false, error: e.message });
      }
    } else {
      results.push({ client: client.slug, service: 'Backblaze B2', ok: null, reason: `Missing ${b2.appKeyId}, ${b2.appKey}, or ${b2.bucket}` });
    }
  }

  // ── 7. n8n executions & workflows ────────────────────────────────────────
  if (process.env.N8N_API_KEY && process.env.N8N_BASE_URL) {
    try {
      const n8nBase    = process.env.N8N_BASE_URL.replace(/\/$/, '') + '/api/v1';
      const n8nHeaders = { 'X-N8N-API-KEY': process.env.N8N_API_KEY, 'Content-Type': 'application/json' };

      // Count executions in the current calendar month (no date filter in API — paginate)
      const now         = new Date();
      const monthStart  = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      let execCount     = 0;
      let cursor        = null;
      let keepGoing     = true;

      while (keepGoing) {
        const qs  = `limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await fetch(`${n8nBase}/executions?${qs}`, { headers: n8nHeaders });
        if (!res.ok) throw new Error(`executions HTTP ${res.status}: ${await res.text()}`);
        const data = await res.json();
        const rows = data.data ?? [];

        for (const row of rows) {
          const started = row.startedAt ?? row.startTime ?? '';
          if (started < monthStart) { keepGoing = false; break; }
          execCount++;
        }

        cursor     = data.nextCursor ?? null;
        if (!cursor || rows.length === 0) keepGoing = false;
      }

      // Count active workflows
      const wfRes = await fetch(`${n8nBase}/workflows?active=true&limit=250`, { headers: n8nHeaders });
      if (!wfRes.ok) throw new Error(`workflows HTTP ${wfRes.status}`);
      const wfData         = await wfRes.json();
      const activeWorkflows = (wfData.data ?? []).length;

      await patchMetric('n8n', 'executions', execCount);
      await patchMetric('n8n', 'workflows',  activeWorkflows);
      results.push({ service: 'n8n', ok: true, executions_this_month: execCount, active_workflows: activeWorkflows });
    } catch (e) {
      results.push({ service: 'n8n', ok: false, error: e.message });
    }
  } else {
    results.push({ service: 'n8n', ok: null, reason: 'N8N_API_KEY or N8N_BASE_URL not set' });
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updated: new Date().toISOString(), results }, null, 2),
  };
};
