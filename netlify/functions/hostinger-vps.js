// Fetches live VPS metrics from the Hostinger API.
// Also syncs disk + bandwidth into Supabase usage_metrics so tracker.html picks them up.
// Required env vars: HOSTINGER_API_KEY, HOSTINGER_VM_ID, SUPABASE_URL, SUPABASE_KEY

const API_BASE = 'https://api.hostinger.com';

exports.handler = async () => {
  const apiKey = process.env.HOSTINGER_API_KEY;
  const vmId   = process.env.HOSTINGER_VM_ID;

  if (!apiKey || !vmId) {
    return json(500, { error: 'HOSTINGER_API_KEY and HOSTINGER_VM_ID env vars are required' });
  }

  try {
    const res = await fetch(
      `${API_BASE}/v1/vps/virtual-machines/${vmId}/metrics`,
      { headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' } }
    );

    if (!res.ok) {
      return json(502, { error: `Hostinger API returned ${res.status}`, detail: await res.text() });
    }

    const body = await res.json();
    const d = body.data || body;

    // All raw values assumed to be in bytes (standard for Hostinger API).
    // If values look off, check the `_raw` field in the response to see actual units.
    const disk = d.disk || {};
    const ram  = d.ram  || d.memory || {};
    const net  = d.network || {};
    const bw   = net.transfer || net.bandwidth || {};
    const cpu  = d.cpu || {};

    const diskUsedGB  = bytesToGB(disk.used  ?? 0);
    const diskTotalGB = bytesToGB(disk.total ?? 0);
    const diskPct     = diskTotalGB > 0 ? (diskUsedGB / diskTotalGB) * 100 : 0;

    const ramUsedGB   = bytesToGB(ram.used  ?? 0);
    const ramTotalGB  = bytesToGB(ram.total ?? 0);
    const ramPct      = ramTotalGB > 0
      ? (ramUsedGB / ramTotalGB) * 100
      : (typeof ram.usage === 'number' ? ram.usage : 0);

    const bwUsedTB    = bytesToTB(bw.used  ?? bw.rx_bytes ?? 0);
    const bwTotalTB   = bytesToTB(bw.total ?? bw.limit    ?? 0);
    const bwPct       = bwTotalTB > 0 ? (bwUsedTB / bwTotalTB) * 100 : 0;

    const cpuPct = typeof cpu.usage   === 'number' ? cpu.usage
                 : typeof cpu.percent === 'number' ? cpu.percent
                 : Array.isArray(cpu.load)          ? cpu.load[0]
                 : 0;

    const metrics = {
      disk:      { used_gb: round(diskUsedGB, 1), total_gb: round(diskTotalGB, 0), pct: round(diskPct, 1) },
      memory:    { used_gb: round(ramUsedGB,  1), total_gb: round(ramTotalGB,  0), pct: round(ramPct,  1) },
      bandwidth: { used_tb: round(bwUsedTB, 3),   total_tb: round(bwTotalTB,  0), pct: round(bwPct,   2) },
      cpu:       { pct: round(cpuPct, 1) },
      fetched_at: new Date().toISOString(),
      _raw: d,
    };

    await syncToSupabase(metrics);

    return json(200, metrics);
  } catch (e) {
    return json(500, { error: e.message });
  }
};

function bytesToGB(n) { return n / 1073741824; }
function bytesToTB(n) { return n / 1099511627776; }
function round(n, dp) { return parseFloat(n.toFixed(dp)); }

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
  if (!url || !key) return;

  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal',
  };

  await fetch(`${url}/rest/v1/usage_metrics?service_name=eq.Hostinger`, {
    method: 'DELETE',
    headers,
  });

  await fetch(`${url}/rest/v1/usage_metrics`, {
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
}
