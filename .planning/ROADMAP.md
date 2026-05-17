# Roadmap: RMT Networks Ops Console

## Overview

Seven phases take the existing VPS from unmonitored to fully instrumented: a hardened foundation with secrets and resource caps baked in before any service is installed, then the alerting backbone (Caddy + Kuma + Telegram + dead-man's-switch), then Netdata for host metrics, then the Node.js bridge that distills those metrics, then the Netlify dashboard and auth gate that surfaces everything in one page, then n8n heartbeats that close the monitoring loop on critical workflows, and finally a two-week tuning audit that drives alert noise to zero. Each phase leaves the system in a testable, observable state before the next begins.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: VPS Prep and Baseline Hardening** - DNS, secrets, resource caps, and Caddy installed before any monitoring service touches the host
- [ ] **Phase 2: Alerting Backbone** - Caddy + Kuma + Telegram + Healthchecks.io dead-man's-switch proven end-to-end before any monitor is added
- [ ] **Phase 3: Netdata Installation** - Host metrics available on loopback, footprint-trimmed, bridge-ready
- [ ] **Phase 4: Node.js Metrics Bridge** - Fastify bridge running as systemd unit, both endpoints verified against live data
- [ ] **Phase 5: Dashboard and Auth Gate** - Netlify ops-proxy edge function + dashboard page live, basic auth covering all paths
- [ ] **Phase 6: n8n Heartbeats** - IF-validate-then-ping pattern on every critical workflow, Telegram fires on missed heartbeat
- [ ] **Phase 7: Tuning Audit and Disk-Watch** - Two-week convergence audit, zero non-actionable alerts, disk-watch push monitor live

## Phase Details

### Phase 1: VPS Prep and Baseline Hardening
**Goal**: The VPS is hardened and ready to receive monitoring services without retroactive disruption — secrets exist, DNS resolves, resource caps are set, Caddy is installed
**Depends on**: Nothing (first phase)
**Requirements**: Foundation phase — no standalone requirement; enables REQ-01 through REQ-08
**Success Criteria** (what must be TRUE):
  1. kuma.rmtnetworks.com and bridge.rmtnetworks.com DNS A-records resolve to the VPS IP
  2. n8n EXECUTIONS_DATA_PRUNE=true and EXECUTIONS_DATA_MAX_AGE=336 confirmed active (n8n not restarted cold — just env confirmed)
  3. Netdata dbengine 256 MB cap config is staged and ready for Phase 3 install
  4. Bridge API key and n8n API key are generated and stored in Netlify env vars and a local secrets file
  5. Caddy is installed and serving a test response on port 443 (TLS provisioned for at least one subdomain)
**Plans**: TBD

### Phase 2: Alerting Backbone
**Goal**: Uptime Kuma is running behind Caddy with Telegram alerts proven end-to-end, the two-tier alert policy is written down, the Supabase health monitor is active, and the Healthchecks.io dead-man's-switch fires when Kuma goes silent
**Depends on**: Phase 1
**Requirements**: REQ-01 (Supabase monitor), REQ-07 (Telegram alert transport + policy), REQ-08 (alert thresholds defined in policy)
**Success Criteria** (what must be TRUE):
  1. Uptime Kuma is reachable at kuma.rmtnetworks.com over HTTPS with WebSocket working (no "disconnected" banner)
  2. A real Telegram alert is received by triggering a deliberate monitor failure — not a test notification button
  3. The Supabase health endpoint monitor is active at 60-second interval with 3 retries configured
  4. The two-tier alert policy (page-worthy vs FYI) is written in a .planning doc before monitor count exceeds 1
  5. Healthchecks.io fires a Telegram alert when the cron ping is stopped for 10 minutes (verified by stopping it)
  6. UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN=true is set in the Kuma container env (not retrofitted later)
**Plans**: TBD
**UI hint**: yes

### Phase 3: Netdata Installation
**Goal**: Netdata agent is running on the VPS, bound to loopback only, footprint-trimmed, with only the five monitored metrics alarmed, and the bridge can successfully read its REST API
**Depends on**: Phase 2
**Requirements**: REQ-02 (Netdata with sensible thresholds for solo-VPS scale)
**Success Criteria** (what must be TRUE):
  1. curl http://127.0.0.1:19999/api/v1/info returns a valid JSON response from within the VPS; port 19999 is not reachable from outside
  2. update every = 5 and dbengine memory mode = dbengine with page cache size = 256 are confirmed in netdata.conf
  3. Only disk, MemAvailable, load5, iowait, and swap alarms are active — all other Netdata default alarms disabled
  4. VPS free RAM is at least 300 MB after Netdata is running alongside n8n and Kuma
**Plans**: TBD

### Phase 4: Node.js Metrics Bridge
**Goal**: The Fastify bridge is running as a systemd unit on 127.0.0.1:8787, serving /host and /n8n/recent with live data, protected by X-Bridge-Key, and reachable at bridge.rmtnetworks.com via Caddy
**Depends on**: Phase 3
**Requirements**: REQ-03 (bridge with host traffic-light and n8n recent-runs endpoints)
**Success Criteria** (what must be TRUE):
  1. curl -H "X-Bridge-Key: <key>" https://bridge.rmtnetworks.com/host returns JSON with a green/yellow/red status field and a one-line reason
  2. curl -H "X-Bridge-Key: <key>" https://bridge.rmtnetworks.com/n8n/recent returns the last 15-20 n8n executions (no raw execution data, no stuck-running false positives)
  3. curl https://bridge.rmtnetworks.com/host (no key) returns HTTP 401
  4. curl https://bridge.rmtnetworks.com/health returns HTTP 200
  5. Kuma has an HTTP monitor on bridge.rmtnetworks.com/health so a dead bridge triggers a Telegram alert
  6. systemctl status rmt-bridge shows active (running) and survives a reboot
**Plans**: TBD

### Phase 5: Dashboard and Auth Gate
**Goal**: The rmtnetworks.com/ops page is live, protected by basic auth on all paths, embeds the Kuma status page via iframe, and displays the host traffic-light and n8n recent-runs widgets pulled server-side through the ops-proxy edge function
**Depends on**: Phase 4
**Requirements**: REQ-05 (dashboard page), REQ-06 (basic auth protection)
**Success Criteria** (what must be TRUE):
  1. Navigating to rmtnetworks.com/ops without credentials returns a 401 browser auth prompt — not the page content
  2. After entering the correct password, the dashboard loads with the Kuma iframe, traffic-light widget, and n8n recent-runs widget all populated
  3. curl -I https://rmtnetworks.com/ops returns 401; curl -I https://rmtnetworks.com/.netlify/functions/ops-proxy returns 401 (both paths gated)
  4. The Kuma iframe renders without a blank frame (UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN=true confirmed working)
  5. Each widget shows a staleness timestamp so it is obvious when data is stale
**Plans**: TBD
**UI hint**: yes

### Phase 6: n8n Heartbeats
**Goal**: Every critical n8n workflow pings its Kuma push monitor on success after validating expected output, and a missed heartbeat triggers a Telegram alert within the configured tolerance window
**Depends on**: Phase 5
**Requirements**: REQ-04 (n8n workflow status via heartbeat push and API pull) — heartbeat push component
**Success Criteria** (what must be TRUE):
  1. Each critical n8n workflow has an IF-validate node asserting expected output before the HTTP Request heartbeat ping — no unconditional pings at workflow end
  2. Each Kuma push monitor is configured at interval = 2× workflow cadence with retries = 1
  3. A forced workflow failure (disabled success branch) results in a Telegram alert within the expected tolerance window
  4. The dashboard n8n recent-runs widget reflects the test failure execution (confirming the API pull half of REQ-04 also works end-to-end)
**Plans**: TBD

### Phase 7: Tuning Audit and Disk-Watch Monitor
**Goal**: After two weeks of real traffic, every non-actionable alert is silenced or demoted, the disk-watch push monitor gives early warning before a disk-full crisis, and the VPS resource envelope is confirmed stable
**Depends on**: Phase 6
**Requirements**: REQ-07 (Telegram alerts — tuned to zero noise), REQ-08 (disk/RAM capacity alerts at approaching-cutoff thresholds: 90%, 95%, 99%)
**Success Criteria** (what must be TRUE):
  1. Zero non-actionable Telegram alerts fired in the 72 hours preceding audit sign-off
  2. A disk-watch cron pings a Kuma push monitor only while disk usage is below 80%; Kuma alerts if the ping stops (disk at or above 80% triggers alert chain)
  3. Kuma monitors are confirmed configured for disk at 90%, 95%, and 99% thresholds with Telegram alerts at each tier
  4. free -m shows at least 300 MB available after all services are running under normal load
  5. df -h shows at least 30% free on the root volume
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. VPS Prep and Baseline Hardening | 0/TBD | Not started | - |
| 2. Alerting Backbone | 0/TBD | Not started | - |
| 3. Netdata Installation | 0/TBD | Not started | - |
| 4. Node.js Metrics Bridge | 0/TBD | Not started | - |
| 5. Dashboard and Auth Gate | 0/TBD | Not started | - |
| 6. n8n Heartbeats | 0/TBD | Not started | - |
| 7. Tuning Audit and Disk-Watch | 0/TBD | Not started | - |
