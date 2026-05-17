# Stack Research

**Domain:** Solo-operator self-hosted monitoring console (Uptime Kuma + Netdata + Node.js bridge + Netlify-rendered dashboard, layered onto an existing n8n VPS)
**Researched:** 2026-05-17
**Overall Confidence:** HIGH on Uptime Kuma, Netdata, Node.js runtime, Caddy, Telegram. MEDIUM on n8n REST API specifics (docs/implementation drift observed). MEDIUM on Netlify free-tier basic-auth path (official docs and community guides contradict).

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended | Confidence |
|------------|---------|---------|-----------------|------------|
| **Uptime Kuma** | `2.3.2` (Docker tag `2`) | HTTP/TCP/keyword monitors, status page (embedded), Telegram alerts, push heartbeats | v2 is stable (GA Oct 2025, regular 2.x patches through May 2026). Built-in Telegram notification provider eliminates need for a separate alerting service. Status page is good enough to embed via iframe per project constraint. | HIGH |
| **Netdata Agent** | Latest stable v2.x agent, **self-hosted only, no Cloud claim** | Host metrics (CPU/RAM/disk/network/process) + local REST API on `:19999` for the bridge to consume | Agent runs locally with a default REST API at `:19999` requiring no auth for localhost. Free, low-footprint (~1-2% CPU, 50-150 MB RAM with ML on; lower with ML off). No need for Netdata Cloud — solo-operator with one node fits well under the 5-node free Cloud cap anyway, but we don't need centralized dashboards. | HIGH |
| **Node.js** | **24.x Active LTS** | Runtime for the metrics bridge | Node 22 is in Maintenance LTS, Node 20 EOL'd April 30, 2026. Node 24 is the current Active LTS and is what new server-side code should target. Matches the existing Netlify Functions runtime family. | HIGH |
| **Fastify** | `5.x` | Web framework for the bridge's two JSON endpoints | Native Node, mature, schema-validated JSON serialization out of the box, ~3x Express throughput, low memory. Hono is faster but its sweet spot is edge runtimes; on a long-running Node process on a VPS, Fastify is the more conservative, "boring infrastructure" choice that matches the project's solo-ops tone. | HIGH |
| **Caddy** | `2.x` (latest stable; 2.8+) | Reverse proxy + automatic TLS for Kuma, Netdata (if exposed), and the bridge under one hostname/subpaths | Three-line `Caddyfile` gives automatic Let's Encrypt issuance and renewal, HTTP→HTTPS redirect, and reverse proxy with subpath routing. ~30 MB RAM idle. Lower operational cost than Nginx+Certbot; lower complexity than Traefik (which is optimized for dynamic Docker label discovery, overkill for 3 static services). | HIGH |
| **systemd** | OS-bundled | Process supervision for the Node.js bridge | Already on the host, zero added daemon overhead, restart-on-failure and journal logging for free. PM2 adds an ~80 MB resident daemon for capabilities (clustering, log rotation, zero-downtime reload) the bridge doesn't need. Docker-supervising one tiny Node service is also overkill given Kuma/Netdata are already containerized. | HIGH |
| **Telegram Bot API** | Current (v9.x bot API) | Alert transport via Uptime Kuma's built-in Telegram integration | Native Kuma integration; no glue code. BotFather flow unchanged for solo bot creation. | HIGH |

### Supporting Libraries (Node.js bridge)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `fastify` | `^5.0.0` | HTTP server + routing + JSON schema validation | Core of the bridge. |
| `undici` | `^7.x` (or use Node 24 built-in `fetch`) | HTTP client for calls to Netdata `:19999` and n8n `/api/v1/executions` | Built into Node 24 as `globalThis.fetch`; prefer that over installing `axios`/`node-fetch`. Use `undici` directly only if you need connection pooling control. |
| `zod` | `^3.x` | Runtime validation of n8n / Netdata responses before composing the JSON the dashboard consumes | Defensive parsing — n8n's API has had doc-vs-impl drift; validating shape catches it early. |
| `pino` | `^9.x` | Structured JSON logging to stdout → captured by `journalctl` | Fastify ships with pino; just use it as-is. |
| `dotenv` | `^16.x` | Local dev env loading | Production reads env from the systemd unit's `Environment=` lines or an `EnvironmentFile=`. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `tsx` or plain JS | Run/iterate the bridge locally | If we go TypeScript: `tsx` for dev, `tsc` for build. If we stay plain JS (consistent with the existing Netlify Functions, which are JS): no build step. **Default to plain JS** to keep the bridge boringly simple. |
| `curl` / `httpie` | Manual API probing of n8n and Netdata during setup | n8n executions endpoint is the one most likely to surprise — probe it before writing the bridge code. |
| `journalctl -u rmt-bridge -f` | Live logs of the systemd-supervised bridge | Standard ops loop. |

---

## Installation

### On the VPS

```bash
# --- Uptime Kuma (Docker) ---
docker run -d --restart=always \
  -p 127.0.0.1:3001:3001 \
  -v uptime-kuma:/app/data \
  --name uptime-kuma \
  louislam/uptime-kuma:2

# --- Netdata Agent (native install, simplest for a single host) ---
# Disable Cloud signup during install; we only want local API on :19999
wget -O /tmp/netdata-kickstart.sh https://get.netdata.cloud/kickstart.sh
sh /tmp/netdata-kickstart.sh --dont-start-it --disable-telemetry --stable-channel
# Edit /etc/netdata/netdata.conf:
#   [web]
#     bind to = 127.0.0.1
# Then: systemctl enable --now netdata

# --- Caddy (TLS-fronting all three services on subpaths/subdomains) ---
# Install via official repo (Debian/Ubuntu example):
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | \
  sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] \
  https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" | \
  sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

### Node.js bridge

```bash
# Core
npm install fastify pino zod

# Dev dependencies (only if going TS — recommended to skip for v1)
# npm install -D tsx typescript @types/node
```

### Caddyfile sketch (single subdomain, subpath routing)

```caddyfile
ops.rmtnetworks.com {
    handle_path /kuma/* {
        reverse_proxy 127.0.0.1:3001
    }
    handle_path /bridge/* {
        reverse_proxy 127.0.0.1:8787
    }
    # Netdata: keep loopback-only; the bridge is the only consumer.
    # No public /netdata/ route — reduces attack surface.
}
```

### systemd unit for the bridge (sketch)

```ini
# /etc/systemd/system/rmt-bridge.service
[Unit]
Description=RMT Networks metrics bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=rmt-bridge
WorkingDirectory=/opt/rmt-bridge
EnvironmentFile=/etc/rmt-bridge.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

---

## Per-Question Answers

### 1. Uptime Kuma

- **Current stable:** 2.3.2 (released May 2026). v2.0 GA'd October 2025; v2.1 in Feb 2026; v2.3 added OracleDB monitor, status-page collapsible groups, WebSocket auth.
- **Deployment mode:** **Docker, tag `louislam/uptime-kuma:2`** (official "recommended" tag per Docker Hub; the project explicitly warns against `:latest`). Bind to loopback and front via Caddy.
- **Persistence:** Single volume mount `uptime-kuma:/app/data`. SQLite by default; v2 added MariaDB option (not needed at this scale).
- **Reverse-proxy expectations:** WebSocket support required (Kuma is Vue + Socket.IO under the hood). Caddy's `reverse_proxy` handles WS automatically — no extra config. If subpath-mounting (e.g. `/kuma/`), confirm Kuma is launched without a forced base path; subpath stripping at the proxy layer with `handle_path` works for status pages but the admin UI is happiest at root. **Recommendation:** give Kuma its own subdomain (`kuma.rmtnetworks.com`) and just embed the status page from there; avoids subpath edge cases entirely.
- **Node version inside the image:** Bundled inside the image; not something to manage from the host. Don't run Kuma bare-metal — Docker is the supported path.
- **Known v2 gotchas:**
  - Legacy browser support removed.
  - Badge endpoints now only accept duration values `24`, `24h`, `30d`, `1y`.
  - **JSON Backup/Restore was removed**; back up the data directory (volume) instead.
  - On Raspberry Pi / slow SQLite, set `UPTIME_KUMA_SQLITE_SINGLE_CONNECTION=true` to avoid lock contention. (Not relevant on a real VPS, but worth knowing.)

### 2. Netdata

- **Cloud vs self-hosted:** **Self-hosted agent only**, no Cloud signup. Cloud free tier is now capped at **5 active nodes and 1 custom dashboard** (changed in 2025); we'd fit, but we don't need centralized dashboards for a single-host setup, and avoiding Cloud signup keeps the data plane local.
- **Local API:** Yes — agent exposes a full REST API on **`:19999`** with **no auth for localhost**. Endpoints like `GET /api/v1/data?chart=system.cpu&after=-60&points=1&format=json` give point-in-time values the bridge can turn into a traffic light. Bind to `127.0.0.1` in `/etc/netdata/netdata.conf` so it's not internet-reachable.
- **Storage / retention:** Default tiered storage on disk; rolling window measured in days for high-res and weeks-to-months for downsampled tiers. Default is sufficient — project explicitly excludes long-term retention.
- **Footprint:** ~1-2% CPU, 50-150 MB RAM at defaults. Disable ML (`[ml] enabled = no` in `netdata.conf`) to drop further if the VPS is tight.

### 3. Node.js bridge

- **Runtime:** **Node.js 24 Active LTS.**
- **Framework:** **Fastify 5**. Express is fine but slower and has less built-in (schema validation, fast JSON serialization). Hono is the modern darling but its design optimizes for edge/serverless runtimes; on a long-lived Node process on a VPS, Fastify is the better fit, more battle-tested in this exact scenario, and gives free schema validation that protects us from n8n response drift. Plain `node:http` is viable for two endpoints but you'll reinvent routing/validation/error-handling badly.
- **Process supervision:** **systemd.** PM2's clustering and zero-downtime-reload are wasted on a tiny read-only JSON service. Docker'ing a single Node file just to supervise it adds image-build and orchestration overhead with no upside. The VPS already has systemd; use it.
- **Auth to n8n:** Static **API key** via the `X-N8N-API-KEY` header (see #4). Store in `/etc/rmt-bridge.env` with mode `0640` owned by the `rmt-bridge` service user; reference from the systemd unit via `EnvironmentFile=`. Talk to n8n over `http://127.0.0.1:5678` (loopback) — no TLS or external network hop.

### 4. n8n REST API

- **Base path:** `/api/v1`. The public REST API must be enabled on the n8n instance; on self-hosted, an API key is generated from the user's Settings → API page.
- **Auth model:** **API key in `X-N8N-API-KEY` header.** This is the only supported auth for the public REST API on current self-hosted n8n. OAuth and session cookies are for the n8n UI itself, not the public API.
- **Executions endpoint:** `GET /api/v1/executions`. Supported query params confirmed by community + issue reports:
  - `workflowId` — filter to a single workflow.
  - `status` — accepts **`success`, `error`, `waiting`, `canceled`** only. The docs sometimes list `running` but the implementation rejects it (issue #19664, marked "not planned"). **Do not rely on `status=running`.**
  - `limit` — page size, default 100, max 250.
  - Cursor-based pagination — response includes a `nextCursor` when more pages exist; pass it as `cursor=` on the follow-up call.
  - `includeData` — controls whether full execution data (input/output blobs) is returned. **Set this `false`** for the dashboard panel; we only need metadata (workflow, status, timestamps).
- **Performance:** Querying recent executions with `includeData=false` is cheap. With `includeData=true` it pulls every node's input/output and can be heavy on busy instances. Cache the bridge's response for ~15-30s to avoid pounding n8n on every dashboard load.
- **Heartbeat / push pattern:** Uptime Kuma push monitors give each monitor a URL like `https://kuma/api/push/<token>?status=up&msg=OK&ping=`. **In each critical n8n workflow, the final success node should HTTP-GET that URL.** Kuma alerts when the heartbeat is missed for longer than the configured interval. This is the bulletproof "did this workflow succeed end-to-end" signal; the executions API pull is for the "recent runs" panel only. Both are needed; don't try to replace heartbeats with API polling.
- **Confidence flag:** n8n's API surface has shifted across recent versions and the docs lag the implementation. **Probe the live instance with `curl` before coding** — confirm pagination shape, the exact `status` enum your version accepts, and whether `includeData=false` is the actual default. Treat any documented behavior as MEDIUM confidence until verified against the live VPS.

### 5. Netlify basic auth — important conflict, read this carefully

There are **two paths**, and the sources contradict on whether path A is free-tier-eligible:

- **Path A — `_headers` file with `Basic-Auth:` rule.** Official Netlify docs (as of May 2026) state this **requires the Pro plan ($20/mo)** and explicitly call it out under "Basic authentication with custom HTTP headers." Several community blog posts (including some hosted on netlify.com's own blog) still describe it as available on all plans. The official docs page is the authoritative source; the community posts appear to be **outdated and should not be relied on for a 2026 build**.
- **Path B — Edge function performing basic auth.** A `netlify/edge-functions/basic_auth.ts` that reads `BASIC_USERNAME` / `BASIC_PASSWORD` env vars and returns 401 with `WWW-Authenticate: Basic` until credentials match. Declared in `netlify.toml` with `[[edge_functions]] path = "/ops/*"`. **Free-tier compatible.** Edge functions are included in all Netlify plans (subject to invocation limits, which a tiny dashboard will never approach).

**Recommendation: Path B (edge function).** Reasons:
1. Works on free tier today, regardless of which docs you believe.
2. Credentials live in Netlify env vars, not in `_headers` (which is committed to git — a real security smell the official docs themselves warn about).
3. Path-scoped: only `/ops/*` (or whatever the dashboard path is) is protected; the rest of the marketing/portal site stays open.
4. If we later upgrade to Pro, we can swap to `_headers` or to Netlify's dashboard-based site password without rewriting anything else.

**Anti-pattern to avoid:** Don't put Basic-Auth credentials in `_headers` committed to git. Even if it worked on free (it doesn't, per official docs), the credentials would be in the repo. Use the edge-function-with-env-vars pattern.

**Confidence:** MEDIUM on the free-tier eligibility of `_headers Basic-Auth` (sources contradict; official wins, but blogs disagree). HIGH on the edge-function approach working on free.

### 6. Reverse proxy / TLS on the VPS

- **Pick: Caddy.** Reasons:
  1. **Automatic TLS** end-to-end — no Certbot cron, no renewal scripts, no expired-cert pages.
  2. **Smallest config burden** — a ~10-line Caddyfile handles all three services.
  3. **Lowest memory footprint** of the three modern options (~30 MB).
  4. We don't need Traefik's Docker-label autodiscovery (the services are static), and we don't need Nginx's raw throughput (this is a single-operator dashboard, not a CDN).
- **Anti-pick: Nginx Proxy Manager.** The UI is nice but the Node.js admin layer adds ~200 MB RAM and an extra attack surface for ops-only infrastructure.
- **Anti-pick: Traefik for this project.** Built for dynamic discovery in container orchestrators. We have three pinned services on one host — its strengths are wasted.
- **Confidence:** HIGH.

### 7. Telegram bot setup

- **Flow unchanged in 2025-2026:** Chat with `@BotFather` → `/newbot` → name + username (must end in `bot`) → receive bot token. Add the bot to your personal chat or a small group; the bot can DM you directly.
- **Chat ID retrieval:** Easiest path is `@userinfobot` (returns your numeric user ID, which is also your chat ID for DMs). Alternative: send any message to your bot, then `GET https://api.telegram.org/bot<TOKEN>/getUpdates` and read `result[0].message.chat.id`.
- **Recent changes worth knowing:**
  - Mid-March 2025: the older "get chat ID for a topic in a group chat" trick stopped working. Not relevant for solo DMs; flag only if you decide later to alert into a group with topics.
  - `@BotFather` now supports transferring bot ownership to another Telegram account (useful for handoff scenarios; not relevant solo).
- **Wire-up in Kuma:** Settings → Notifications → New → Telegram. Paste bot token and chat ID. Test. Attach to monitors.
- **Confidence:** HIGH.

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Fastify | Hono | Only if the bridge ever moves to an edge runtime (Cloudflare Workers, Vercel Edge). Not the case here. |
| Fastify | Express | Acceptable but slower and noisier; pick only if you strongly value the larger middleware ecosystem (we don't need it for two endpoints). |
| Fastify | Plain `node:http` | Acceptable if you commit to writing routing, validation, and error handling yourself. For two endpoints this is feasible but offers no real saving over Fastify. |
| systemd | PM2 | If you grow to multiple Node services on the same host and want a unified dashboard/log viewer. Not worth it for one tiny service. |
| systemd | Docker (for the bridge) | If you decide to ship the bridge as a container alongside Kuma/Netdata for deploy parity. Adds image build pipeline — not justified for a 200-line service that ships via `git pull` + `systemctl restart`. |
| Caddy | Nginx + Certbot | If you have a strong existing Nginx-shop preference or need its specific perf characteristics. Neither applies here. |
| Caddy | Traefik | If you're already running everything through Docker Compose with labels and want one proxy to discover services dynamically. We have 3 fixed services; Traefik is overkill. |
| Netlify edge-function basic auth | Netlify `_headers` Basic-Auth | If you're on Pro and want to keep `netlify.toml` as the single source of truth. Otherwise stay with the edge-function approach. |
| Netlify edge-function basic auth | Netlify dashboard "Password Protection" (Pro) | If you upgrade to Pro and want a styled login page instead of the browser prompt. Cosmetic — solo operator doesn't care. |
| Self-hosted Netdata agent only | Netdata Cloud (free tier, ≤5 nodes) | If you ever add a second VPS and want a unified dashboard. Single-host setup doesn't benefit. |
| Uptime Kuma | Healthchecks.io (self-hosted) | Only if you specifically want cron-style "did this run on schedule" semantics rather than HTTP/TCP uptime + heartbeats. Kuma covers both via push monitors. |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **Node.js 18, 20, or 22 for new code** | 18/20 EOL'd already, 22 in Maintenance LTS only. | Node.js 24 Active LTS. |
| **`uptime-kuma:latest` Docker tag** | Project explicitly warns against `:latest` — no version pinning, surprise major upgrades. | `louislam/uptime-kuma:2` (recommended floating-major tag) or pin to `2.3.2`. |
| **JSON Backup/Restore in Kuma v2** | Removed in v2. | Back up the Docker volume (`/app/data`) directly via filesystem snapshot or `docker run --rm -v uptime-kuma:/data ...` tar dump. |
| **Netdata Cloud signup** | Not needed for one node; pulls you into a tier-cap relationship with no benefit. | Self-hosted agent, bind to loopback. |
| **Exposing Netdata `:19999` to the public internet** | No auth on the local dashboard by default. | Bind to `127.0.0.1` in `netdata.conf`; only the bridge talks to it over loopback. |
| **Filtering n8n executions by `status=running`** | Documented but rejected by the API (issue #19664, won't fix). | Query without status filter and post-filter in the bridge, or query the four valid statuses (`success`, `error`, `waiting`, `canceled`). |
| **n8n API calls with `includeData=true` from the dashboard hot path** | Pulls full per-node input/output, expensive on busy instances. | Explicit `includeData=false`; cache bridge response 15-30s. |
| **Hardcoding basic-auth credentials in a `_headers` file in git** | Credentials end up in the repo even if the repo is private. Netlify's own docs warn about this. | Edge function reading `Netlify.env.get('BASIC_USERNAME'/'BASIC_PASSWORD')`. |
| **PM2 for a single tiny service on a constrained VPS** | ~80 MB resident daemon for capabilities you don't use. | systemd unit. |
| **Nginx Proxy Manager** for this project | Adds Node.js admin UI (~200 MB RAM) and an extra attack surface for an ops-only stack. | Plain Caddy with a 10-line Caddyfile. |
| **Building a custom dashboard rendering Kuma's API from scratch** | Project explicitly out of scope. | Embed Kuma's own status page via iframe; compose only the bridge widgets around it. |
| **Bare-metal Uptime Kuma install** | Not the supported path; Docker is documented and battle-tested. | Docker with named volume. |

---

## Stack Patterns by Variant

**If the bridge ever needs to serve more than two endpoints / take POSTs / handle webhooks:**
- Stay on Fastify.
- Add `@fastify/rate-limit` for any public-facing endpoint.
- Otherwise no architectural change.

**If you later add a second VPS or want a unified ops view:**
- Sign up Netdata Cloud (still free at ≤5 nodes), claim both agents to it, embed the Cloud room in the dashboard.
- Move Kuma to MariaDB (v2-supported) for HA and back up via `mysqldump`.
- Otherwise the stack scales as-is.

**If Telegram becomes too noisy:**
- Two Kuma notification channels: a "critical" Telegram chat for outages and a "warnings" Telegram chat for capacity thresholds. Both via the same bot, different chat IDs.
- Do **not** add email; that's an explicit project Out-of-Scope.

**If you decide you want the Kuma admin UI publicly reachable instead of just the status page:**
- Front Kuma with the same edge-function basic auth pattern at the Caddy layer (Caddy has a `basicauth` directive). Belt-and-suspenders to Kuma's own login.

---

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `louislam/uptime-kuma:2` | Docker engine current; ARM64 + AMD64 | Persistent volume required; do **not** point an existing v1 volume at the v2 image without running the documented migration first. |
| Netdata agent v2.x | Linux kernel 4.x+ (any current VPS) | Reads `/proc`, `/sys`; no special privileges beyond `netdata` user. |
| Node.js 24 LTS | Fastify 5, `undici` 7, `pino` 9, `zod` 3 | Native `fetch` is in core; no polyfill needed. |
| Fastify 5 | Node 20+ (require 24 for LTS) | Plugins ecosystem fully v5-compatible as of mid-2025. |
| n8n public REST API `/api/v1` | n8n self-hosted (any current 1.x release with public API enabled) | Verify the exact `status` enum your installed version accepts; doc-vs-impl drift observed. |
| Caddy 2.x | Let's Encrypt ACME v2 | Automatic; nothing to configure unless you want ZeroSSL fallback. |
| Netlify edge functions | All Netlify plans, all current site types | Deno runtime; uses Web `Request`/`Response`, not Node APIs. |

---

## Confidence Summary

| Recommendation | Confidence | Why |
|----------------|------------|-----|
| Uptime Kuma 2.x via Docker | HIGH | Verified against GitHub releases and Docker Hub. |
| Netdata self-hosted agent, loopback-bound | HIGH | Verified against Netdata docs and pricing page. |
| Node.js 24 LTS | HIGH | Verified against nodejs.org release schedule. |
| Fastify over Hono/Express for a VPS Node service | HIGH | Multiple recent benchmarks and 2026 framework comparisons agree on the use-case fit. |
| systemd over PM2/Docker for the bridge | HIGH | Standard solo-VPS practice; resource-efficiency confirmed. |
| Caddy over Nginx/Traefik for this project | HIGH | Three independent 2026 comparisons reach the same conclusion for the "single VPS, automatic TLS, static services" shape. |
| Telegram bot setup unchanged | HIGH | Verified against bot API changelog. |
| n8n `X-N8N-API-KEY` auth, `/api/v1/executions` shape | MEDIUM | Auth model verified, but executions endpoint has known doc-vs-impl drift; probe the live instance before coding. |
| Netlify free-tier basic-auth via edge functions | HIGH (the recommendation), but the **alternative** path (`_headers` Basic-Auth on free) is MEDIUM with sources contradicting | Official docs say `_headers Basic-Auth` is Pro-only; multiple community blogs claim it works on free. Edge-function path is the safe choice. |

---

## Sources

**Uptime Kuma (HIGH)**
- [Uptime Kuma releases on GitHub](https://github.com/louislam/uptime-kuma/releases) — verified 2.3.2 (May 2026) as current stable.
- [louislam/uptime-kuma on Docker Hub](https://hub.docker.com/r/louislam/uptime-kuma) — `2` is the recommended production tag; `:latest` is deprecated.
- [Uptime Kuma 2.0 release coverage (Linuxiac)](https://linuxiac.com/uptime-kuma-2-0-arrives-with-mariadb-support-modern-ui-refresh/) — v2 GA October 2025.
- [Uptime Kuma 2.3 release coverage (Linuxiac)](https://linuxiac.com/uptime-kuma-2-3-adds-oracledb-monitoring-and-status-page-groups/) — recent feature additions.
- [Docker Tags wiki](https://github.com/louislam/uptime-kuma/wiki/Docker-Tags) — tag conventions, slim vs full variants.

**Netdata (HIGH)**
- [Netdata Agent REST API docs](https://learn.netdata.cloud/docs/rest-api/api) — local `:19999` API, no-auth-on-localhost confirmed.
- [Netdata pricing page](https://www.netdata.cloud/pricing/) — free Cloud tier capped at 5 nodes / 1 custom dashboard.
- [Reducing Netdata footprint (community forum)](https://community.netdata.cloud/t/reduce-memory-footprint-of-netdata-agent/5026) — knobs for ML/health disable.

**Node.js (HIGH)**
- [Node.js previous releases](https://nodejs.org/en/about/previous-releases) — Node 24 Active LTS, 22 Maintenance, 20 EOL April 2026.
- [endoflife.date for Node.js](https://endoflife.date/nodejs) — confirmation of LTS schedule.

**Framework choice (HIGH)**
- [Better Stack: Fastify vs Express vs Hono](https://betterstack.com/community/guides/scaling-nodejs/fastify-vs-express-vs-hono/) — 2026 benchmarks.
- [HireNodeJS 2026 frameworks comparison](https://www.hirenodejs.com/blog/nodejs-frameworks-compared-2026) — independent corroboration.
- [Encore Cloud Node frameworks roundup](https://encore.cloud/resources/node-js-frameworks).

**Process supervision (HIGH)**
- [Oxmgr 2026 process manager comparison](https://oxmgr.empellio.com/blog/process-manager-comparison) — systemd-vs-PM2 tradeoffs on small VPS.
- [Leapcell PM2 vs Docker](https://leapcell.io/blog/pm2-and-docker-choosing-the-right-process-manager-for-node-js-in-production).

**Reverse proxy (HIGH)**
- [Hostim.dev reverse proxy comparison 2026](https://hostim.dev/blog/reverse-proxy-showdown/) — perf and memory numbers.
- [ZeonEdge: Nginx vs Caddy vs Traefik 2026](https://zeonedge.com/blog/nginx-vs-caddy-vs-traefik-comparison).
- [Virtua.cloud: Traefik vs Caddy vs Nginx for Docker](https://www.virtua.cloud/learn/en/concepts/traefik-caddy-nginx-docker-reverse-proxy).

**n8n API (MEDIUM — doc/impl drift observed)**
- [n8n API docs root](https://docs.n8n.io/api/) — public REST API overview.
- [n8n authentication docs](https://docs.n8n.io/api/authentication/) — `X-N8N-API-KEY` header confirmed.
- [n8n API reference](https://docs.n8n.io/api/api-reference/) — endpoint list and OpenAPI spec.
- [GitHub issue #19664: status=running rejected](https://github.com/n8n-io/n8n/issues/19664) — concrete doc-vs-impl mismatch.
- [Community thread on executions listing](https://community.n8n.io/t/tutorial-listing-running-workflow-exections-with-api/172501) — real-world parameter usage.

**Netlify basic auth (MEDIUM — official docs vs community blogs contradict on free-tier)**
- [Netlify docs: Basic auth with custom headers](https://docs.netlify.com/manage/security/secure-access-to-sites/basic-authentication-with-custom-http-headers/) — official position: Pro-plan only.
- [Netlify blog: restricting access with passwords](https://www.netlify.com/blog/restricting-access-to-netlify-sites-with-passwords/) — older blog, claims all-plans.
- [jbabington.com — edge-function basic auth](https://www.jbabington.com/basic-authentication-with-netlify-edge-functions) — full free-tier implementation; the recommended path.
- [GitHub: acestojanoski/netlify-basic-auth-edge-function](https://github.com/acestojanoski/netlify-basic-auth-edge-function) — drop-in alternative.

**Telegram (HIGH)**
- [Telegram Bot API changelog](https://core.telegram.org/bots/api-changelog) — March 2025 topic-chat-ID behavior change noted; otherwise stable.
- [BotFather creation walkthrough (gist)](https://gist.github.com/nafiesl/4ad622f344cd1dc3bb1ecbe468ff9f8a) — flow unchanged.

---
*Stack research for: solo-operator self-hosted monitoring console layered on an existing n8n VPS, rendered through Netlify*
*Researched: 2026-05-17*
