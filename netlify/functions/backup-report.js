// backup-report.js — a client site's nightly backup job reports its result here.
//
// POST  Authorization: Bearer <that site's report token>
//       { status: 'pass'|'fail', run_url, db_status, files_status, db_bytes,
//         restore_tables, restore_rows, files_count, files_copied }
//
// The token identifies the site: its SHA-256 is looked up in backup_sites, so a
// token can only ever write runs for its own site. No user session involved.
// Read side: backup-status.js (Rob-only), shown on the portal's Backups tile.
//
// Required Netlify env vars: SUPABASE_URL, SUPABASE_KEY (secret key)

'use strict';

const crypto = require('crypto');

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const JOB_STATES = new Set(['success', 'failure', 'cancelled', 'skipped']);
const int = (v) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.trunc(Number(v)) : null);
const jobState = (v) => (JOB_STATES.has(v) ? v : null);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const token = (event.headers.authorization || event.headers.Authorization || '')
    .replace(/^Bearer\s+/i, '').trim();
  if (!token) return json(401, { error: 'Unauthorized' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  if (body.status !== 'pass' && body.status !== 'fail') {
    return json(400, { error: "status must be 'pass' or 'fail'" });
  }
  const runUrl = typeof body.run_url === 'string' && /^https:\/\/github\.com\//.test(body.run_url)
    ? body.run_url.slice(0, 500) : null;

  const base = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_KEY;
  if (!base || !key) return json(503, { error: 'Supabase not configured' });
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  try {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const siteRes = await fetch(
      `${base}/rest/v1/backup_sites?select=slug&active=eq.true&token_sha256=eq.${hash}`,
      { headers }
    );
    if (!siteRes.ok) return json(502, { error: `Site lookup failed (${siteRes.status})` });
    const [site] = await siteRes.json();
    if (!site) return json(401, { error: 'Unauthorized' });

    const row = {
      site:           site.slug,
      status:         body.status,
      run_url:        runUrl,
      db_status:      jobState(body.db_status),
      files_status:   jobState(body.files_status),
      db_bytes:       int(body.db_bytes),
      restore_tables: int(body.restore_tables),
      restore_rows:   int(body.restore_rows),
      files_count:    int(body.files_count),
      files_copied:   int(body.files_copied),
    };
    const ins = await fetch(`${base}/rest/v1/backup_runs`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify(row),
    });
    if (!ins.ok) return json(502, { error: `Insert failed (${ins.status})`, detail: await ins.text() });

    return json(201, { ok: true, site: site.slug });
  } catch (e) {
    return json(500, { error: e.message || 'Unknown error' });
  }
};
