# RMT Networks Ops Console

## What This Is

A single-operator monitoring system for the RMT Networks infrastructure: a self-hosted Uptime Kuma + Netdata stack on the existing VPS, a small Node.js metrics bridge, and an embedded dashboard at rmtnetworks.com that surfaces VPS health, Supabase health, and n8n workflow runs. Telegram is the pager; the dashboard is the daily check-in. Built by and for the solo founder/operator — no separate "CEO" audience exists.

## Core Value

When something that matters breaks, I find out via Telegram within minutes; when nothing is broken, opening one page tells me everything is fine.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Uptime Kuma deployed on the existing VPS, configured to monitor Supabase health endpoint and at least one HTTP-based liveness signal per critical workflow path
- [ ] Netdata deployed on the same VPS, exposing host metrics (CPU, RAM, disk, network) with sensible thresholds for the solo-VPS scale
- [ ] Custom Node.js metrics bridge running on the VPS, exposing two JSON endpoints: (a) simplified host metrics traffic-light derived from Netdata, (b) n8n recent execution history pulled from n8n's REST API
- [ ] n8n workflow status reported two ways: (i) Uptime Kuma heartbeat URLs pinged on success from each critical workflow's success path, (ii) full execution history pulled from n8n's API for the "recent runs" panel
- [ ] Dashboard page on rmtnetworks.com that embeds Uptime Kuma's status page and composes the bridge widgets (host traffic light, n8n recent runs) into one view
- [ ] Dashboard is protected by basic auth (single shared password) — not publicly indexable, not behind Supabase login
- [ ] Telegram alerts fire from Uptime Kuma on: any monitored service down, any heartbeat missed, any host capacity warning (e.g., disk ≥ X%, RAM sustained ≥ Y%)
- [ ] Disk/RAM capacity alerts include "approaching cutoff" thresholds (e.g., disk 90%, 95%, 99%) so I get warning before a hard failure

### Out of Scope

- rmtnetworks.com public-site uptime monitoring — not the operational concern this project addresses; the marketing/portal site is not where ops risk lives
- Email alerts to a CEO or any second recipient — single-operator setup; Telegram is sufficient; adding email is alert-fatigue risk without value
- Daily digest emails — same reason; Telegram + the dashboard already cover both real-time and at-a-glance views
- Public status page — the dashboard is ops-only, not a customer trust page
- Full custom dashboard rendering Kuma data from scratch — embedding Kuma's own status page is sufficient and avoids re-implementing what it already does well
- Multi-host / multi-tenant monitoring — only the one VPS and its colocated services
- Auth via Supabase login — basic auth is simpler and the dashboard doesn't need user identity
- Long-term metrics retention / capacity planning charts — Netdata's default rolling window is enough; not building a time-series warehouse

## Context

- Existing site `rmtnetworks.com` is a Netlify-hosted dark-themed CRUD app backed by Supabase, with Netlify functions used as a proxy layer. The dashboard page will live in this same site (consistent stack and deploy flow). See `memory/project_rmtnetworks.md`.
- n8n is self-hosted on the same VPS that will run Uptime Kuma and Netdata. This means: the bridge can talk to n8n over localhost, Netdata sees the n8n process for free, and the alerting surface is one host.
- The operator is solo and is both the technical owner and the audience. The "CEO dashboard" framing in the original outline was loose shorthand — there is no separate executive recipient. This simplifies alert routing and access control.
- Specific n8n workflows that warrant heartbeat monitors will be enumerated during phase planning (operator will list them); the architecture supports adding more over time without code changes.
- Uptime Kuma's built-in Telegram notification integration is the alerting transport — no separate notification service needed.

## Constraints

- **Tech stack**: Node.js for the metrics bridge — consistent with the existing Netlify Functions tooling; no Python/Go on the VPS for this project.
- **Hosting**: Single existing VPS hosts Uptime Kuma, Netdata, n8n, and the bridge. No new infra is provisioned by this project.
- **Frontend**: Dashboard page lives in the existing rmtnetworks.com Netlify site. Same deploy flow as the subscription tracker.
- **Auth**: Basic auth via Netlify (single shared password). Do not introduce user accounts for this surface.
- **Alerting**: Telegram only. No email, no PagerDuty, no SMS.
- **Budget**: Stay within the existing VPS resource envelope. The stack must coexist with whatever is already running there.
- **Operator scale**: One person. Solutions that need a team to operate (rotations, on-call schedules, runbook reviews) are out.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Embed Uptime Kuma's status page rather than building a custom dashboard from its API | Faster to ship, Kuma's UI is already good, custom rendering adds no value at this scale | — Pending |
| Run Kuma + Netdata + n8n + bridge on the single existing VPS | n8n already lives there; colocation simplifies networking and alerting surface | — Pending |
| Use both heartbeat URLs (push) and n8n API (pull) for workflow monitoring | Heartbeats give bulletproof "did this critical run succeed" signal; API pull gives full visibility for the dashboard panel | — Pending |
| Telegram only — no email, no second recipient | Solo operator; second channel adds noise without information | — Pending |
| Basic auth on the dashboard | Lighter than Supabase auth, stronger than obfuscation, and the page has no per-user state | — Pending |
| Exclude rmtnetworks.com uptime from this project's monitors | The site itself isn't the ops risk surface; the automation and data layer behind it is | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-05-16 after initialization*
