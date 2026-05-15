// Fetches live VPS metrics from the Hostinger API.
// Also syncs disk + bandwidth into Supabase usage_metrics so tracker.html picks them up.
// Required env vars: HOSTINGER_API_KEY, HOSTINGER_VM_ID, SUPABASE_URL, SUPABASE_KEY

const API_BASE = 'https://developers.hostinger.com/api';

exports.handler = async () => {
  const apiKey = process.env.HOSTINGER_API_KEY;
  const vmId   = process.env.HOSTINGER_VM_ID;

  if (!apiKey || !vmId) {
    return json(500, { error: 'HOSTINGER_API_KEY and HOSTINGER_VM_ID env vars are required' });
  }

  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' };

  try {
    // Fetch VM plan details for totals (disk/memory/bandwidth limits)
    const vmRes = await fetch(`${API_BASE}/vps/v1/virtual-machines/${vmId}`, { headers });
    if (!vmRes.ok) {
      return json(502, { error: `Hostinger VM API ${vmRes.status}`, detail: await vmRes.text() });
    }
    const vm = await vmRes.json();

    // Plan limits are in MB
    const diskTotalGB = vm.disk     / 1024;              // e.g. 102400 MB → 100 GB
    const ramTotalGB  = vm.memory   / 1024;              // e.g. 8192 MB  → 8 GB
    const bwTotalTB   = vm.bandwidth / 1024 / 1024;      // e.g. 8192000 MB → ~7.8 TB

    // Fetch metrics for the current calendar month
    const now        = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const dateFrom   = monthStart.toISOString().slice(0, 19) + 'Z';
    const dateTo     = now.toISOString().slice(0, 19) + 'Z';

    const mRes = await fetch(
      `${API_BASE}/vps/v1/virtual-machines/${vmId}/metrics?date_from=${encodeURIComponent(dateFrom)}&date_to=${encodeURIComponent(dateTo)}`,
      { headers }
    );
    if (!mRes.ok) {
      return json(502, { error: `Hostinger metrics API ${mRes.status}`, detail: await mRes.text() });
    }
    const m = await mRes.json();

    // Get most recent data point (highest Unix timestamp key)
    const tsKeys   = Object.keys(m.cpu_usage?.usage || {}).map(Number).sort((a, b) => b - a);
    const latest   = String(tsKeys[0]);

    const cpuPct     = m.cpu_usage?.usage?.[latest]   ?? 0;
    const ramUsedGB  = (m.ram_usage?.usage?.[latest]  ?? 0) / 1073741824;
    const diskUsedGB = (m.disk_space?.usage?.[latest] ?? 0) / 1073741824;

    // Monthly bandwidth = sum all incoming + outgoing intervals
    const allTs      = Object.keys(m.incoming_traffic?.usage || {});
    const bwUsedBytes = allTs.reduce((sum, ts) => {
      return sum
        + (m.incoming_traffic?.usage?.[ts]  ?? 0)
        + (m.outgoing_traffic?.usage?.[ts]  ?? 0);
    }, 0);
    const bwUsedTB = bwUsedBytes / 1099511627776;

    const metrics = {
      disk: {
        used_gb:  round(diskUsedGB, 1),
        total_gb: round(diskTotalGB, 0),
        pct:      round((diskUsedGB / diskTotalGB) * 100, 1),
      },
      memory: {
        used_gb:  round(ramUsedGB, 1),
        total_gb: round(ramTotalGB, 0),
        pct:      round((ramUsedGB / ramTotalGB) * 100, 1),
      },
      bandwidth: {
        used_tb:  round(bwUsedTB, 4),
        total_tb: round(bwTotalTB, 1),
        pct:      round((bwUsedTB / bwTotalTB) * 100, 3),
      },
      cpu: { pct: round(cpuPct, 1) },
      fetched_at: now.toISOString(),
    };

    const syncResult = await syncToSupabase(metrics);
    return json(200, { ...metrics, _sync: syncResult });
  } catch (e) {
    return json(500, { error: e.message, stack: e.stack });
  }
};

function round(n, dp) { return parseFloat(Number(n).toFixed(dp)); }

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function syncToSupabase(metrics) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return { ok: false, error: 'missing env vars' };

  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal',
  };

  try {
    const delRes = await fetch(`${url}/rest/v1/usage_metrics?service_name=eq.Hostinger`, {
      method: 'DELETE',
      headers,
    });

    const insRes = await fetch(`${url}/rest/v1/usage_metrics`, {
      method: 'POST',
      headers,
      body: JSON.stringify([
        {
          service_name: 'Hostinger',
          metric_name:  'disk',
          metric_label: 'Disk',
          used_value:   metrics.disk.used_gb,
          limit_value:  metrics.disk.total_gb,
          unit:         'GB',
          last_updated: metrics.fetched_at,
        },
        {
          service_name: 'Hostinger',
          metric_name:  'bandwidth',
          metric_label: 'Bandwidth',
          used_value:   metrics.bandwidth.used_tb,
          limit_value:  metrics.bandwidth.total_tb,
          unit:         'TB',
          last_updated: metrics.fetched_at,
        },
      ]),
    });

    const insBody = await insRes.text();
    return { ok: insRes.ok, del_status: delRes.status, ins_status: insRes.status, ins_body: insBody };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
