// GET /.netlify/functions/dashboard
// Everything the CEO dashboard (portal.html) shows, computed in one call.
// Rob and Katy only. Max's access is the Clients app.
//
// Panels:
//   active   - active clients: stage, latest status, days since update, next step
//   owed     - clients with charges > payments (same math as clients.html), total
//   next     - next step per active client + open tasks with due dates
//   waiting  - waiting-on / sent-pending / client-questions items, oldest first
//   pipeline - prospects by stage with deal value; follow-ups due within 7 days
//   limits   - usage_metrics against plan limits, highest % first
//
// Backups come from backup-status.js; the page calls it separately.
'use strict';

const { authenticate } = require('../../lib/portal-auth.js');

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const STALE_DAYS = 7; // matches command-center.html

async function get(path) {
  const r = await fetch(process.env.SUPABASE_URL + '/rest/v1' + path, {
    headers: { apikey: process.env.SUPABASE_KEY },
  });
  if (!r.ok) throw new Error(`${path.split('?')[0]}: HTTP ${r.status}`);
  return r.json();
}

const num = (v) => (v == null || v === '' ? 0 : parseFloat(v)) || 0;
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const DAY = 86400000;
const daysSince = (iso, now) => (iso ? Math.floor((now - new Date(iso).getTime()) / DAY) : null);
const ymd = (d) => d.toISOString().slice(0, 10);

function build(clients, usage, now) {
  const today = ymd(new Date(now));
  const in7 = ymd(new Date(now + 7 * DAY));
  const brief = (c) => ({ id: c.id, name: c.name || '—', company: c.company || '' });

  // Active clients ------------------------------------------------------------
  const activeRows = clients.filter((c) => c.status === 'active');
  const active = activeRows
    .map((c) => {
      const age = daysSince(c.status_updated_at, now);
      return {
        ...brief(c),
        project_status: c.project_status || null,
        current_status: text(c.current_status),
        updated_days: age,
        stale: age == null || age >= STALE_DAYS,
        monthly_rate: num(c.contracted_monthly_rate) || null,
      };
    })
    .sort((a, b) => (b.updated_days ?? 1e9) - (a.updated_days ?? 1e9));

  // Money owed (charges - payments, all statuses) -----------------------------
  const owedRows = [];
  let totalReceived = 0;
  let receivedThisMonth = 0;
  const monthPrefix = today.slice(0, 7);
  for (const c of clients) {
    const charged = (c.client_charges || []).reduce((s, x) => s + num(x.amount), 0);
    const pays = c.client_payments || [];
    const received = pays.reduce((s, x) => s + num(x.amount), 0);
    totalReceived += received;
    receivedThisMonth += pays.filter((p) => (p.paid_on || '').startsWith(monthPrefix)).reduce((s, x) => s + num(x.amount), 0);
    const balance = charged - received;
    if (balance > 0.005) {
      const lastPaid = pays.map((p) => p.paid_on).filter(Boolean).sort().pop() || null;
      const lastCharge = (c.client_charges || []).map((x) => x.charged_on).filter(Boolean).sort().pop() || null;
      owedRows.push({ ...brief(c), status: c.status, balance: +balance.toFixed(2), charged: +charged.toFixed(2), last_paid: lastPaid, last_charge: lastCharge });
    }
  }
  owedRows.sort((a, b) => b.balance - a.balance);
  const owed = {
    total: +owedRows.reduce((s, r) => s + r.balance, 0).toFixed(2),
    received_this_month: +receivedThisMonth.toFixed(2),
    received_total: +totalReceived.toFixed(2),
    clients: owedRows,
  };

  // Next steps: active clients' next_up + open tasks ----------------------------
  const next = [];
  for (const c of activeRows) {
    const d = c.status_detail || {};
    if (text(d.next_up)) next.push({ ...brief(c), kind: 'next', text: text(d.next_up), updated_days: daysSince(c.status_updated_at, now) });
    for (const t of c.client_tasks || []) {
      if (t.status === 'done') continue;
      next.push({ ...brief(c), kind: t.is_milestone ? 'milestone' : 'task', text: t.title, due: t.due_date || null, overdue: !!(t.due_date && t.due_date < today) });
    }
  }
  next.sort((a, b) => (b.overdue - a.overdue) || ((a.due || '9999') < (b.due || '9999') ? -1 : 1) || ((b.updated_days ?? 0) - (a.updated_days ?? 0)));

  // Waiting on clients (active + prospects) ---------------------------------
  const waiting = [];
  for (const c of clients) {
    if (c.status !== 'active' && c.status !== 'prospect') continue;
    const d = c.status_detail || {};
    const age = daysSince(c.status_updated_at, now);
    if (text(d.waiting_on)) waiting.push({ ...brief(c), kind: 'Waiting on client', text: text(d.waiting_on), days: age });
    if (text(d.sent_pending)) waiting.push({ ...brief(c), kind: 'Sent, awaiting reply', text: text(d.sent_pending), days: age });
    if (text(d.client_questions)) waiting.push({ ...brief(c), kind: 'Their questions to answer', text: text(d.client_questions), days: age });
  }
  waiting.sort((a, b) => (b.days ?? 0) - (a.days ?? 0));

  // Pipeline ------------------------------------------------------------------
  const STAGES = ['new_lead', 'contacted', 'proposal_sent', 'won', 'lost'];
  const prospects = clients.filter((c) => c.status === 'prospect');
  const stages = STAGES.map((s) => {
    const rows = prospects.filter((c) => (c.pipeline_stage || 'new_lead') === s);
    return { stage: s, count: rows.length, value: +rows.reduce((t, c) => t + num(c.deal_value), 0).toFixed(2) };
  });
  const followups = clients
    .filter((c) => c.next_followup_date && c.next_followup_date <= in7 && !['former', 'lost'].includes(c.status))
    .map((c) => ({ ...brief(c), status: c.status, date: c.next_followup_date, overdue: c.next_followup_date < today }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const pipeline = {
    open_count: prospects.filter((c) => !['won', 'lost'].includes(c.pipeline_stage)).length,
    open_value: +prospects.filter((c) => !['won', 'lost'].includes(c.pipeline_stage)).reduce((t, c) => t + num(c.deal_value), 0).toFixed(2),
    stages,
    prospects: prospects.map((c) => ({ ...brief(c), stage: c.pipeline_stage || 'new_lead', deal_value: num(c.deal_value) || null, next_up: text((c.status_detail || {}).next_up) })),
    followups,
  };

  // Plan limits -----------------------------------------------------------------
  const limits = usage
    .filter((u) => num(u.limit_value) > 0)
    .map((u) => ({
      service: u.service_name,
      metric: u.metric_label || u.metric_name,
      used: num(u.used_value),
      limit: num(u.limit_value),
      unit: u.unit || '',
      pct: Math.round((num(u.used_value) / num(u.limit_value)) * 1000) / 10,
      updated_days: daysSince(u.last_updated, now),
      client_id: u.client_id || null,
    }))
    .sort((a, b) => b.pct - a.pct);

  return { generated_at: new Date(now).toISOString(), active, owed, next, waiting, pipeline, limits };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  const who = await authenticate(event);
  if (who !== 'Rob' && who !== 'Katy') return json(401, { error: 'Unauthorized' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) return json(503, { error: 'Supabase not configured' });

  try {
    const [clients, usage] = await Promise.all([
      get('/clients?select=id,name,company,status,project_status,current_status,status_updated_at,status_detail,pipeline_stage,deal_value,next_followup_date,contracted_monthly_rate,client_charges(amount,charged_on),client_payments(amount,paid_on),client_tasks(title,status,due_date,is_milestone)&order=name.asc'),
      get('/usage_metrics?select=service_name,metric_name,metric_label,used_value,limit_value,unit,last_updated,client_id'),
    ]);
    return json(200, build(clients, usage, Date.now()));
  } catch (e) {
    console.error('dashboard: ' + e.message);
    return json(502, { error: e.message || 'Failed to load dashboard' });
  }
};

exports._build = build; // for tests
