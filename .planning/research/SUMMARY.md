# Project Research Summary

**Project:** RMT Networks Ops Console
**Domain:** Solo-operator self-hosted monitoring console (Uptime Kuma + Netdata + Node.js bridge + Netlify dashboard)
**Researched:** 2026-05-17
**Confidence:** HIGH

## Executive Summary

This is a single-operator monitoring console built on top of an existing n8n VPS. The canonical approach is to compose purpose-built open-source tools rather than building from scratch or bolting on heavyweight SaaS: Uptime Kuma 2 for active probes and heartbeats, Netdata for host metrics, and a thin Node.js bridge as the only custom integration. Caddy handles TLS and reverse-proxying for all services. The dashboard lives as one page in the existing Netlify site, protected by a Netlify edge-function basic-auth gate, and embeds the Kuma status page via iframe rather than re-implementing it. The only genuinely custom code is the bridge (~150 LOC) and the edge function (~30 LOC).

The data plane is loopback-only: every internal component binds to 127.0.0.1; Caddy is the sole internet-facing process. The Netlify edge function (ops-proxy) proxies the two bridge endpoints server-side, keeping the bridge API key out of the browser. The dashboard pulls; nothing pushes to it. Alerting flows the opposite direction: Kuma fires outbound to Telegram on state changes. n8n workflows push heartbeats to Kuma over the public Caddy path, validating the public ingress on every success. One external dead-mans-switch (Healthchecks.io, free tier) is the only off-VPS dependency beyond Telegram itself.

The two risks that most commonly derail this class of project are alert fatigue and resource contention on a shared VPS. Alert fatigue is mitigated by defining a two-tier alert policy (page-worthy vs FYI) before adding the first monitor, and running a two-week tuning audit before declaring the project done. Resource contention is mitigated by applying Netdata footprint trims, Kuma retention caps, and n8n execution pruning on day zero before installation, and budgeting at least 300 MB RAM headroom at all times.

## Key Findings

### Recommended Stack

The stack is fully determined by research with HIGH confidence across the board. Uptime Kuma 2.x runs in Docker (tag louislam/uptime-kuma:2) bound to loopback, fronted by Caddy. Netdata is installed natively via kickstart.sh --disable-cloud, bound to 127.0.0.1:19999, never exposed publicly. The Node.js bridge runs as a systemd unit (not PM2, not Docker) -- single tiny read-only service and systemd is already on the host. Caddy handles automatic TLS for both kuma.rmtnetworks.com and bridge.rmtnetworks.com with a ~10-line Caddyfile. The Netlify basic-auth gate must be implemented as an edge function reading env vars, not via _headers Basic-Auth, which is a Pro-plan-only feature despite outdated community posts claiming otherwise.

**Core technologies:**
- **Uptime Kuma 2.3.2** via louislam/uptime-kuma:2 Docker tag -- active HTTP/TCP/keyword probes, push heartbeats, Telegram alerting, embeddable status page. The one source of truth for whether something is down.
- **Netdata agent v2.x** (self-hosted, no Cloud) -- host metrics via REST API on :19999 (loopback only). Bridge is the only consumer; Netdata is never exposed to the internet.
- **Node.js 24 LTS + Fastify 5** -- bridge runtime and framework. Node 24 is Active LTS (22 is Maintenance-only, 20 is EOL). Fastify chosen over Hono (edge-optimized, wrong context) and Express (slower, no built-in validation).
- **Caddy 2.x** -- sole reverse proxy and TLS terminator. Automatic TLS, transparent WebSocket support (critical for Kuma), ~30 MB RAM idle.
- **systemd** -- process supervisor for the bridge. PM2 adds ~80 MB daemon overhead for capabilities this single-instance read-only service does not need.
- **Telegram Bot API** -- alerting transport via Kumas native integration. No glue code needed.
- **Netlify edge function** -- basic-auth gate for /ops/* and /.netlify/functions/ops-*; server-side proxy injecting the bridge API key. Free-tier compatible; avoids CORS and keeps the key out of the browser.

### Expected Features

**Must have (table stakes):**
- Kuma HTTP(S) monitor on Supabase health endpoint (60s interval, 3 retries before alert)
- Kuma push (heartbeat) monitor per critical n8n workflow -- the ONLY signal for scheduled-and-missed
- Kuma TCP monitor on n8n port and SSL cert monitor on the dashboard domain (14-day warning)
- Kuma Telegram notification with two-tier policy defined before adding monitor #1
- Netdata with alarms whitelisted to: disk %, MemAvailable, load5/vCPU, iowait, swap thrash -- defaults disabled
- Disk Telegram alerts at 90%, 95%, 99% (80% is dashboard yellow only, not a page)
- Bridge endpoints: /host (traffic light green/yellow/red + one-line reason), /n8n/recent (last 15-20 executions, 60s cache, includeData=false), /health (200 OK)
- Kuma HTTP monitor on bridge /health so a dead bridge pages
- Dashboard: iframe of Kuma status page + host traffic-light widget + n8n recent-runs widget + staleness stamps, behind basic-auth gate
- Netlify ops-proxy edge function proxying /host and /n8n with injected X-Bridge-Key
- UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN=true set at Kuma install time (+ Caddy CSP frame-ancestors https://rmtnetworks.com)
- At least one n8n workflow with IF-validate-then-heartbeat pattern before rolling out to more
- External dead-mans-switch via Healthchecks.io (free) -- set up in Phase 1, not deferred

**Should have (v1.x, triggered by incidents):**
- Supabase synthetic read query (trigger: API up but app sees errors incident)
- Stuck-execution detector in bridge (trigger: first stuck-execution incident)
- n8n execution duration regression flag (trigger: first slow-and-looked-fine incident)
- Mobile-friendly single-column dashboard layout
- Kuma maintenance windows for planned reboots

**Defer to v2+:**
- Anything multi-host (out of scope per PROJECT.md)
- Public status page (out of scope)
- Grafana/Prometheus/time-series warehousing (anti-feature for this scope)

### Architecture Approach

The architecture is a loopback-only VPS data plane behind a single Caddy reverse proxy, surfaced through a Netlify-hosted dashboard that calls a server-side proxy function rather than the bridge directly. Every internal component binds to 127.0.0.1; Caddy is the only process on 0.0.0.0:443. The Netlify edge function is the single consumer of the bridges public HTTPS endpoints. Kumas status page is embedded via iframe; heartbeats from n8n deliberately exit the VPS through Caddy, validating the public ingress on each success ping. One Healthchecks.io check is the only component intentionally off the VPS.

**Major components:**
1. **Caddy** -- TLS termination, reverse proxy for Kuma (:3001) and bridge (:8787) on separate subdomains. Must use subdomains -- Kuma does not support subpath serving.
2. **Uptime Kuma 2** -- active probes, push heartbeats, Telegram dispatch. SQLite in a named Docker volume.
3. **Netdata agent** -- host metrics via loopback API at :19999. Bridge is its only consumer; never exposed publicly.
4. **Node.js bridge (systemd unit)** -- reads Netdata and n8n APIs on demand; distilled JSON; X-Bridge-Key auth; lazy pull-through cache (30s host / 60s n8n).
5. **n8n** (pre-existing, minimally touched) -- add API key generation and one HTTP Request node per critical workflow success branch.
6. **Netlify edge function (ops-proxy)** -- server-side proxy injecting X-Bridge-Key; same-origin from browser; basic-auth gate for /ops/*.
7. **Healthchecks.io** (off-VPS) -- cron ping every 5 minutes from a script that first verifies Kuma is locally alive.

### Critical Pitfalls

1. **Alert fatigue from day-one defaults** -- Define the two-tier alert policy before adding monitor #1. Set 3 retries on all HTTP monitors. Whitelist only the five Netdata metrics; disable the rest. Run a two-week tuning audit targeting zero non-actionable alerts in the last 72 hours.

2. **Heartbeat says green, workflow actually failed** -- Every push heartbeat must use an IF-validate-then-ping pattern: assert expected output before the HTTP Request node; ping ?status=down&msg=validation_failed on the false branch. Never place the heartbeat unconditionally at workflow end.

3. **Kuma iframe blocked by X-Frame-Options** -- Set UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN=true at Kuma install time. Add Caddy header Content-Security-Policy: frame-ancestors https://rmtnetworks.com. If retrofitted after Phase 4, debugging the blank iframe is a time sink.

4. **n8n executions API tarpits** -- Always pass ?limit=20&includeData=false. Verify EXECUTIONS_DATA_PRUNE=true before building the bridge. The status=running filter is rejected by the implementation (GitHub issue #19664) -- post-filter in the bridge instead. Wrap the n8n API client in a thin adapter module so version drift breaks only one file.

5. **Disk-full death spiral from colocated retention defaults** -- Apply before installing: Netdata dbengine 256 MB cap, Kuma history 30 days, n8n EXECUTIONS_DATA_MAX_AGE=336 + EXECUTIONS_DATA_PRUNE=true. Add a Kuma push monitor driven by a cron that only pings when disk is under 80%.

6. **Netlify basic-auth holes** -- Edge-function gate must cover both /ops/* and /.netlify/functions/ops-*. Smoke-test all path types with curl -I. Never use _headers Basic-Auth (Pro-plan-only per official docs).

7. **VPS dies, no alert fires** -- Set up Healthchecks.io in Phase 1 alongside Kuma. Verify the alert fires when the cron is stopped for 10 minutes before declaring Phase 1 done.
## Implications for Roadmap

### Phase 0: VPS Prep and Baseline Hardening

**Rationale:** Retention and resource caps cannot be retroactively applied without stopping services. Secrets generated here are consumed by Phases 1 and 4. Pitfalls 4, 5, and 8 require Phase 0 action.
**Delivers:** n8n execution pruning confirmed on; Netdata footprint config staged; Caddy installed; DNS records created (kuma.rmtnetworks.com and bridge.rmtnetworks.com pointing to VPS IP); n8n API key generated; bridge API key stored in Netlify env vars; VPS memory baseline (n8n RSS) documented.
**Addresses:** Pitfall 4 (resource contention), Pitfall 5 (n8n pruning), Pitfall 8 (disk-full spiral).
**Research flag:** Standard patterns -- no research phase needed.

### Phase 1: Caddy + Kuma + Telegram + Dead-Mans-Switch

**Rationale:** Kuma is the alerting backbone. Telegram must be proven end-to-end before adding monitors. Dead-mans-switch must co-deploy with Kuma. iframe env var must be set at install time, not retrofitted.
**Delivers:** Kuma running behind Caddy (HTTPS + WebSocket); Telegram provider tested; first monitor (Supabase HTTPS, 3 retries); Healthchecks.io dead-mans-switch verified; UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN=true set; two-tier alert policy documented before any monitor is added.
**Addresses:** Pitfall 1 (alert fatigue policy), Pitfall 3 (watching the watcher), Pitfall 10 (iframe X-Frame-Options set at install).
**Exit gate:** One real Telegram alert received AND Healthchecks.io fires when cron is stopped 10 minutes. Do not proceed until both pass.
**Research flag:** Standard patterns.

### Phase 2: Netdata Installation

**Rationale:** Fully independent of Kuma; can begin as soon as Caddy is up. Required before the bridge can be written.
**Delivers:** Netdata bound to 127.0.0.1:19999; update every = 5, dbengine 256 MB cap, unused plugins disabled; public port confirmed blocked; alarms whitelisted to the five monitored metrics.
**Addresses:** Pitfall 4 (resource contention -- Netdata footprint trims).
**Research flag:** Standard patterns.

### Phase 3: Node.js Metrics Bridge

**Rationale:** Depends on Netdata (Phase 2) and n8n API key (Phase 0). Writing the bridge against live local data catches integration issues before the dashboard is built.
**Delivers:** systemd unit rmt-bridge at 127.0.0.1:8787; /host, /n8n/recent, /health endpoints; X-Bridge-Key auth; lazy pull-through cache (30s/60s); includeData=false and limit=20 on n8n calls; thin n8n API adapter module; Caddy site block for bridge.rmtnetworks.com; curl verified 200 with key and 401 without.
**Addresses:** Pitfall 5 (n8n API tarpits), Pitfall 7 (bridge behind Caddy + HTTPS).
**Research flag:** MEDIUM -- probe the live n8n instance with curl before writing the bridge client to confirm executions endpoint shape and valid status enum values for the installed version. The documented status=running filter is rejected by the implementation; do not code against it.

### Phase 4: Dashboard and Netlify Auth Gate

**Rationale:** Dashboard consumes both bridge (Phase 3) and Kuma status page (Phase 1). Edge function is both the auth gate and bridge proxy -- implement together so path coverage is tested as a unit.
**Delivers:** Edge function gating /ops/* and /.netlify/functions/ops-* via env vars; ops-proxy injecting X-Bridge-Key; dashboard HTML with embedded Kuma iframe, traffic-light widget, n8n recent-runs widget, staleness stamps; curl smoke test passing for all three path types.
**Addresses:** Pitfall 6 (Netlify basic-auth holes), Pitfall 7 (no CORS), Pitfall 10 (iframe verified in incognito after auth).
**Research flag:** Standard -- use edge function, not _headers Basic-Auth.

### Phase 5: n8n Heartbeats

**Rationale:** Editing existing n8n workflows is a separate concern from infrastructure. Heartbeats are the only signal for scheduled-and-missed -- not optional.
**Delivers:** Each critical n8n workflow modified with IF-validate-then-ping pattern; Kuma push monitors at interval = 2x workflow cadence, retries = 1; forced-failure test confirming Telegram fires on a missed heartbeat.
**Addresses:** Pitfall 2 (heartbeat lies -- IF-validate pattern enforced for every heartbeat).
**Research flag:** Standard patterns -- fully documented in PITFALLS.md.

### Phase 6: Tuning Audit and Disk-Watch Monitor

**Rationale:** Two weeks of real operation surfaces alert noise and resource surprises that no up-front config eliminates. Skipping this phase is how alert channels get muted permanently.
**Delivers:** Two-week alert audit log with decision per alert; all non-actionable alerts silenced or demoted; Kuma push monitor driven by disk-watch cron (pings only while disk < 80%); monthly maintenance cron; free -m >= 300 MB; df -h >= 30% free.
**Addresses:** Pitfall 1 (alert fatigue -- two-week convergence audit), Pitfall 4 (resource re-measure), Pitfall 8 (disk leading-indicator + monthly maintenance).
**Research flag:** Standard operational tuning -- no research phase needed.

### Phase Ordering Rationale

- Phase 0 before everything: caps and secrets cannot be added retroactively without disruption.
- Phase 1 before Phase 2: Telegram must be proven before Netdata alarms can be routed. Phase 2 can begin as soon as Caddy is up without waiting for Phase 1 exit gate.
- Phase 3 after Phases 1 and 2: bridge reads from Netdata and n8n; testing against live data validates the monitoring loop closes.
- Phase 4 after Phase 3: nothing to proxy until the bridge exists; Kuma (Phase 1) provides the iframe source.
- Phase 5 after Phase 4: push monitor URLs created in this phase; verifying them is easier with the dashboard live.
- Phase 6 last: requires real production traffic to measure.

### Research Flags

Phases likely needing a research-phase step during planning:
- **Phase 3 (Bridge):** Probe the live n8n instance with curl before writing the bridge client. Research is HIGH confidence on overall API shape but MEDIUM on per-version field semantics and valid status enum values.

Phases with standard patterns (skip research-phase):
- **Phase 0:** Standard Linux VPS config.
- **Phase 1:** Kuma Docker + Caddy + Telegram bot -- thoroughly documented.
- **Phase 2:** Netdata kickstart install with one config file to edit.
- **Phase 4:** Netlify edge function basic-auth -- known pattern with reference implementation.
- **Phase 5:** n8n HTTP Request node + Kuma push monitors -- both documented in detail.
- **Phase 6:** Operational tuning -- observation and threshold adjustment, no new technology.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All core technology choices verified against official docs and current releases. Exception: Netlify _headers Basic-Auth free-tier eligibility is MEDIUM due to contradicting sources -- use edge function to sidestep this entirely. |
| Features | HIGH | Table-stakes features derived from PROJECT.md requirements; thresholds anchored to Netdata defaults and industry practice. |
| Architecture | HIGH | Component boundaries, loopback-only data plane, and Netlify proxy pattern verified against official docs. Specific bridge endpoint schema is MEDIUM (design judgment, not vendor fact). |
| Pitfalls | HIGH / MEDIUM | Kuma iframe flag, n8n status=running rejection, Netlify function path scope, and Netdata footprint knobs confirmed against official docs or GitHub issues. Threshold recommendations (300 MB headroom) synthesized from community sources. |

**Overall confidence:** HIGH

### Gaps to Address

- **n8n executions API field schema on the installed version:** Before writing the bridge client, run curl against the live n8n instance and inspect the actual response shape. Record it in a comment in clients/n8n.ts.
- **VPS current memory baseline:** Measure actual n8n RSS before Phase 0 to confirm the 300 MB headroom budget is realistic. If n8n already exceeds 700 MB, disable Netdata ML.
- **Which n8n workflows get heartbeats:** PROJECT.md defers enumeration to phase planning. Operator must list critical workflows and their cadences before Phase 5 begins.
- **Subdomain DNS records:** kuma.rmtnetworks.com and bridge.rmtnetworks.com must point to the VPS IP before Phase 1 TLS provisioning.

## Sources

### Primary (HIGH confidence)
- https://hub.docker.com/r/louislam/uptime-kuma -- v2.3.2 current stable, louislam/uptime-kuma:2 recommended tag
- https://github.com/louislam/uptime-kuma/wiki/Reverse-Proxy -- subpath limitation, WebSocket requirements
- https://github.com/louislam/uptime-kuma/issues/5621 -- UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN=true confirmed
- https://learn.netdata.cloud/docs/rest-api/api -- local :19999 API, no auth for localhost
- https://learn.netdata.cloud/docs/netdata-agent/configuration/securing-agents -- web.bind to = 127.0.0.1
- https://nodejs.org/en/about/previous-releases -- Node 24 Active LTS, 22 Maintenance, 20 EOL April 2026
- https://docs.n8n.io/api/authentication/ -- X-N8N-API-KEY header confirmed
- https://docs.n8n.io/hosting/scaling/execution-data/ -- EXECUTIONS_DATA_PRUNE env vars
- https://caddyserver.com/docs/caddyfile/directives/reverse_proxy -- transparent WebSocket support
- https://docs.netlify.com/manage/security/secure-access-to-sites/basic-authentication-with-custom-http-headers/ -- Pro-plan-only for _headers Basic-Auth
- https://healthchecks.io/ -- free tier, pull-based dead-mans-switch model

### Secondary (MEDIUM confidence)
- https://github.com/n8n-io/n8n/issues/19664 -- status=running filter rejected by implementation (wont fix)
- https://www.jbabington.com/basic-authentication-with-netlify-edge-functions -- free-tier edge-function implementation
- https://community.netdata.cloud/t/reduce-memory-footprint-of-netdata-agent/5026 -- update every = 5 and dbengine cap knobs
- https://github.com/louislam/uptime-kuma/issues/2445 -- retries as grace-period mechanism for push monitors
- https://betterstack.com/community/guides/scaling-nodejs/fastify-vs-express-vs-hono/ -- 2026 benchmarks supporting Fastify for VPS Node services
- https://oxmgr.empellio.com/blog/process-manager-comparison -- systemd vs PM2 resource tradeoffs
- https://flowgenius.in/n8n-stuck-executions-detection/ -- push heartbeat + API pull dual-signal rationale
- https://cloudpap.com/blog/uptime-kuma-embed/ -- CSP frame-ancestors pattern with Caddy

---
*Research completed: 2026-05-17*
*Ready for roadmap: yes*
