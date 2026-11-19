#!/usr/bin/env node
// anthropic-costs.mjs: Anthropic API spend by workspace and API key (and optionally
// model or day), from the Usage and Cost Analytics API (beta).
//
//   node scripts/anthropic-costs.mjs                 # last 30 days, by workspace + key
//   node scripts/anthropic-costs.mjs --days 90       # longer ranges are split into 31-day calls
//   node scripts/anthropic-costs.mjs --model         # also split by model
//   node scripts/anthropic-costs.mjs --daily         # one row per UTC day (spot the Sunday runs)
//   node scripts/anthropic-costs.mjs --since 2026-11-01
//
// Needs an org-level key: Console -> API keys -> Create key, scope = the whole
// organization (not a workspace), linked to an admin. Legacy sk-ant-admin keys work too.
// Read from the ANTHROPIC_ADMIN_KEY env var, else ANTHROPIC_ADMIN_KEY in this repo's
// .env (gitignored, so never deployed), else ~/.anthropic/admin-key. Never printed.
// Data lags 4-24 hours; starting_at can't be before 2026-01-01 or >365 days back.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const API = 'https://api.anthropic.com/v1/organizations'
const HEADERS = {
  'anthropic-version': '2026-10-21',
  'anthropic-beta': 'analytics-usage-cost-2026-08-24',
}
const DAY = 86_400_000
const MAX_SPAN_DAYS = 31

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
if (flag('--help') || flag('-h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 14).join('\n'))
  process.exit(0)
}
const byModel = flag('--model')
const daily = flag('--daily')
const now = new Date()
let start = opt('--since')
  ? new Date(`${opt('--since')}T00:00:00Z`)
  : new Date(now.getTime() - Number(opt('--days') ?? 30) * DAY)
const floor = new Date(Math.max(Date.UTC(2026, 0, 1), now.getTime() - 365 * DAY + DAY))
if (Number.isNaN(start.getTime())) die('Bad --since date; use YYYY-MM-DD.')
if (start < floor) start = floor

// ── key ─────────────────────────────────────────────────────────────────────
let key = (process.env.ANTHROPIC_ADMIN_KEY ?? '').trim()
if (!key) {
  try {
    const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.env')
    const m = readFileSync(envFile, 'utf8').match(/^ANTHROPIC_ADMIN_KEY\s*=\s*["']?([^"'\r\n]+)/m)
    if (m) key = m[1].trim()
  } catch {}
}
if (!key) {
  try {
    key = readFileSync(join(homedir(), '.anthropic', 'admin-key'), 'utf8').trim()
  } catch {}
}
if (!key) die('No admin key. Add ANTHROPIC_ADMIN_KEY=... to the rmtnetworks .env file.')
// Accepted: a legacy Admin API key (sk-ant-admin...) or an organization-scoped key
// linked to an admin user or service account (sk-ant-usr... / sk-ant-svc...). A
// workspace-scoped key gets a 401/403 from these endpoints.
HEADERS['x-api-key'] = key

function die(msg) {
  console.error(msg)
  process.exit(1)
}

async function get(path, params) {
  const url = `${API}${path}?${params.toString()}`
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) {
    const body = await res.text()
    die(`${res.status} on ${path}: ${body.slice(0, 400)}`)
  }
  return res.json()
}

// ── names for IDs ───────────────────────────────────────────────────────────
async function listAll(path) {
  const out = []
  let after
  for (;;) {
    const p = new URLSearchParams({ limit: '100' })
    if (after) p.set('after_id', after)
    const r = await get(path, p)
    out.push(...(r.data ?? []))
    if (!r.has_more || !r.last_id) return out
    after = r.last_id
  }
}
const [workspaces, apiKeys] = await Promise.all([
  listAll('/workspaces'),
  listAll('/api_keys'),
])
const wsName = new Map(workspaces.map((w) => [w.id, w.name]))
const keyName = new Map(apiKeys.map((k) => [k.id, `${k.name}${k.status && k.status !== 'active' ? ` (${k.status})` : ''}`]))
const nameWs = (id) => (id ? wsName.get(id) ?? id : 'Default Workspace')
const nameKey = (id) => (id ? keyName.get(id) ?? id : '(no key: console / other)')

// ── cost rows, in ≤31-day windows ───────────────────────────────────────────
const totals = new Map()
let refreshed = null
for (let s = start; s < now; s = new Date(s.getTime() + MAX_SPAN_DAYS * DAY)) {
  const e = new Date(Math.min(s.getTime() + MAX_SPAN_DAYS * DAY, now.getTime()))
  let page
  for (;;) {
    const p = new URLSearchParams({
      starting_at: s.toISOString(),
      ending_at: e.toISOString(),
      limit: '1000',
    })
    p.append('group_by[]', 'workspace_id')
    p.append('group_by[]', 'api_key_id')
    if (byModel) p.append('group_by[]', 'model')
    if (daily) {
      p.set('time_bucket_width', '1d')
      p.set('order_by', 'time')
      p.set('order', 'asc')
    }
    if (page) p.set('page', page)
    const r = await get('/analytics/cost', p)
    if (r.data_refreshed_at) refreshed = r.data_refreshed_at
    for (const row of r.data ?? []) {
      const g = row.group ?? {}
      const day = daily ? row.starting_at.slice(0, 10) : ''
      const k = [day, nameWs(g.workspace_id), nameKey(g.api_key_id), byModel ? g.model ?? '-' : ''].join('\u0000')
      const t = totals.get(k) ?? { cents: 0, requests: 0 }
      t.cents += Number(row.cost?.amount ?? 0)
      t.requests += Number(row.cost?.requests ?? 0)
      totals.set(k, t)
    }
    if (!r.has_more) break
    page = r.next_page
  }
}

// ── print ───────────────────────────────────────────────────────────────────
const cols = [daily && 'Day', 'Workspace', 'API key', byModel && 'Model', 'Requests', 'Cost'].filter(Boolean)
const rows = [...totals.entries()]
  .map(([k, t]) => {
    const [day, ws, apiKey, model] = k.split('\u0000')
    return { day, ws, apiKey, model, ...t }
  })
  .sort((a, b) => (daily ? a.day.localeCompare(b.day) : 0) || b.cents - a.cents)
const usd = (cents) => `$${(cents / 100).toFixed(2)}`
const table = rows.map((r) =>
  [daily && r.day, r.ws, r.apiKey, byModel && r.model, String(r.requests), usd(r.cents)].filter((v) => v !== false),
)
const width = cols.map((c, i) => Math.max(c.length, ...table.map((r) => r[i].length)))
const line = (cells) => cells.map((c, i) => (i >= cells.length - 2 ? c.padStart(width[i]) : c.padEnd(width[i]))).join('  ')

console.log(`Anthropic cost, ${start.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)} (UTC)`)
console.log(`Data refreshed: ${refreshed ?? 'no data yet for this range'}\n`)
if (!rows.length) {
  console.log('No cost rows.')
} else {
  console.log(line(cols))
  console.log(width.map((w) => '-'.repeat(w)).join('  '))
  for (const r of table) console.log(line(r))
  const sum = rows.reduce((a, r) => a + r.cents, 0)
  console.log(`\nTotal: ${usd(sum)}  (after discounts, before credits)`)
}
