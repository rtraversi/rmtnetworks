// backup-status.js — Rob-only status for the portal's Backups tile.
//
// GET  Authorization: Bearer <rmt session token (Rob only)>
//
// Returns { sites: [{ slug, label, state, reason, ran_at, last_pass_at,
//                     run_url, db_bytes, restore_rows, files_count, files_copied }] }
//
// state is 'green' only when the latest run passed AND it is recent (within the
// site's expected_hours). A failed run, or no run at all inside the window, is
// 'red': a job that silently stops running must not keep showing green.
//
// Writes come from backup-report.js. Required env: SESSION_SECRET, SUPABASE_URL, SUPABASE_KEY.

'use strict';

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

function isRob(authHeader) {
  const token = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || !process.env.SESSION_SECRET) return false;
  return token === process.env.SESSION_SECRET;
}

// Exported for tests.
function assess(site, latest, now = Date.now()) {
  if (!latest) return { state: 'red', reason: 'No backup reported yet' };
  const ageHours = (now - Date.parse(latest.ran_at)) / 3600000;
  if (latest.status === 'fail') {
    const parts = [];
    if (latest.db_status && latest.db_status !== 'success') parts.push(`database ${latest.db_status}`);
    if (latest.files_status && latest.files_status !== 'success') parts.push(`documents ${latest.files_status}`);
    return { state: 'red', reason: 'Last run failed' + (parts.length ? ` (${parts.join(', ')})` : '') };
  }
  if (ageHours > site.expected_hours) {
    return { state: 'red', reason: `No backup in ${Math.floor(ageHours)}h (expected every ${site.expected_hours}h)` };
  }
  return { state: 'green', reason: 'Last run passed' };
}

exports.assess = assess;
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  if (!isRob(event.headers.authorization || event.headers.Authorization)) {
    return json(401, { error: 'Unauthorized' });
  }

  const base = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_KEY;
  if (!base || !key) return json(503, { error: 'Supabase not configured' });
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const get = async (path) => {
    const r = await fetch(`${base}/rest/v1/${path}`, { headers });
    if (!r.ok) throw new Error(`${path.split('?')[0]}: HTTP ${r.status}`);
    return r.json();
  };

  try {
    const sites = await get('backup_sites?select=slug,label,expected_hours&active=eq.true&order=label.asc');
    const out = await Promise.all(sites.map(async (s) => {
      const slug = encodeURIComponent(s.slug);
      const [[latest], [lastPass]] = await Promise.all([
        get(`backup_runs?select=*&site=eq.${slug}&order=ran_at.desc&limit=1`),
        get(`backup_runs?select=ran_at&site=eq.${slug}&status=eq.pass&order=ran_at.desc&limit=1`),
      ]);
      return {
        slug: s.slug,
        label: s.label,
        ...assess(s, latest),
        ran_at:       latest?.ran_at ?? null,
        last_pass_at: lastPass?.ran_at ?? null,
        run_url:      latest?.run_url ?? null,
        db_bytes:     latest?.db_bytes ?? null,
        restore_rows: latest?.restore_rows ?? null,
        files_count:  latest?.files_count ?? null,
        files_copied: latest?.files_copied ?? null,
      };
    }));
    return json(200, { sites: out });
  } catch (e) {
    return json(502, { error: e.message || 'Unknown error' });
  }
};
