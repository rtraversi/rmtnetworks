# Architecture Research

**Domain:** Solo-operator self-hosted monitoring console (Uptime Kuma + Netdata + Node.js bridge + embedded dashboard)
**Researched:** 2026-05-16
**Confidence:** HIGH for stock component behavior (Kuma, Netdata, n8n, Caddy, Netlify) verified via official docs; MEDIUM for the specific glue (bridge endpoints, CORS choice) which is a design judgment, not a vendor fact.

---

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│  CLIENT (Operator's browser)                                              │
│  https://rmtnetworks.com/ops (Netlify, basic-auth gated)                  │
│                                                                            │
│   ┌────────────────────────┐    ┌──────────────────────────────────┐     │
│   │ Dashboard page         │    │ <iframe> embedding Kuma status   │     │
│   │  - host traffic light  │    │  page (https://kuma.rmt.../status)│     │
│   │  - n8n recent runs     │    └──────────────────────────────────┘     │
│   └──────────┬─────────────┘                                              │
└──────────────┼────────────────────────────────────────────────────────────┘
               │ HTTPS (fetch)
               │ Path: /.netlify/functions/ops-proxy/{host|n8n}
               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  NETLIFY EDGE                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Function: ops-proxy                                                 │  │
│  │  - injects bridge auth header (BRIDGE_API_KEY env var)             │  │
│  │  - forwards GET /host  and /n8n  to bridge over HTTPS              │  │
│  │  - no CORS dance: same-origin from the dashboard                   │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ HTTPS (origin pull, server-to-server)
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  VPS  (single host, existing)                                             │
│                                                                            │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  Caddy (PUBLIC: :80, :443)  — sole internet-facing process         │  │
│  │   kuma.rmt...     -> 127.0.0.1:3001   (WebSocket, Kuma UI/status)  │  │
│  │   bridge.rmt...   -> 127.0.0.1:8787   (JSON, requires API key)     │  │
│  │   (Netdata NOT exposed — localhost only)                            │  │
│  │   (n8n: existing host/route, untouched by this project)            │  │
│  └────────┬────────────────────┬────────────────────┬──────────────────┘  │
│           │                    │                    │                      │
│           ▼                    ▼                    ▼                      │
│  ┌──────────────┐   ┌────────────────────┐   ┌──────────────────────┐    │
│  │ Uptime Kuma  │   │ Node.js bridge      │   │ n8n (PRE-EXISTING)   │    │
│  │ :3001 (lo)   │   │ :8787 (lo)          │   │ :5678 (lo, existing) │    │
│  │ SQLite ./data│   │ in-memory cache     │   │ owns its own DB      │    │
│  └──────┬───────┘   └─────────┬───────────┘   └──────────┬───────────┘    │
│         │ HTTP                │ HTTP                     ▲                 │
│         │ monitor checks      │ GET /api/v1/executions   │                 │
│         │ (Supabase, n8n,     │ X-N8N-API-KEY            │                 │
│         │  heartbeat URLs)    └──────────────────────────┘                 │
│         │                                                                  │
│         │       ┌──────────────────────────────────────────┐               │
│         └──────►│ Netdata agent :19999 (lo only)           │◄──────┐      │
│         scrape  │ web.bind to = 127.0.0.1                  │       │      │
│                 │ /api/v1/data?chart=system.cpu (etc.)     │       │      │
│                 └──────────────────────────────────────────┘       │      │
│                                                                     │      │
│                              Bridge also scrapes Netdata API ───────┘      │
│                              (localhost, no auth needed)                    │
│                                                                             │
│  Process supervisor: systemd (one unit per service)                         │
│  Logs: journald  (journalctl -u kuma | netdata | bridge)                    │
│  Outbound: Kuma → api.telegram.org (Telegram alerts)                        │
└────────────────────────────────────────────────────────────────────────────┘
              ▲                                              │
              │ Heartbeat HTTPS POST/GET                     │ Telegram Bot API
              │ from n8n workflow "success" branch           │ HTTPS outbound
              │ to https://kuma.rmt.../api/push/<token>      ▼
              │                                          ┌───────────┐
   (n8n workflow lives on the same VPS                   │ Telegram  │
    but the heartbeat call goes out through Caddy        │ (operator)│
    so it also validates the public path works)          └───────────┘
```

### Component Responsibilities

| Component | Responsibility | Implementation |
|-----------|----------------|----------------|
| **Caddy** | Sole TLS termination + reverse proxy + automatic Let's Encrypt; the only process bound to 0.0.0.0:443 | Single Caddyfile, three site blocks (kuma, bridge, plus existing). WebSocket upgrade is transparent. |
| **Uptime Kuma** | Active probes (Supabase health, public endpoints), passive heartbeats (push monitors from n8n), Telegram notifier, public status page | Official Docker image or native; binds 127.0.0.1:3001; SQLite in `./data`. |
| **Netdata agent** | Host metrics (CPU, RAM, disk, network, per-process) with rolling in-memory retention | Native install (`kickstart.sh --disable-cloud`), bound to 127.0.0.1:19999 via `web.bind to`. |
| **Bridge (Node.js)** | Two read-only JSON endpoints. `/host` = traffic-light derived from Netdata API. `/n8n` = recent executions via n8n REST API, cached. Validates a static API key header on every request. | Express/Fastify, ~150 LOC, no DB, in-memory LRU cache (TTL 30s host / 60s n8n). Runs as a systemd unit, binds 127.0.0.1:8787. |
| **n8n** (pre-existing) | Workflow execution; emits heartbeat HTTP calls on workflow success; exposes REST API for read-only consumption | Untouched by this project beyond (a) generating an API key for the bridge and (b) adding HTTP Request nodes on the success branch of each critical workflow. |
| **Netlify ops-proxy function** | Server-side fetch from the Netlify edge to bridge.rmt.... Injects `X-Bridge-Key`. Avoids CORS and keeps the API key out of the browser. | Single TypeScript handler, deployed alongside existing functions. |
| **Dashboard page** | One static HTML page that (a) iframes the Kuma status page and (b) calls `/.netlify/functions/ops-proxy/host` and `/n8n` every 30–60s, rendering the traffic light + recent runs table | Vanilla JS or whatever the rest of the site uses. No build-step gymnastics. |
| **External dead-man's-switch** | Watches the watcher: pings something OUTSIDE the VPS so that "VPS or Kuma down" still alerts | Free Healthchecks.io check + a cron job on the VPS that curls its ping URL every 5 min. If the VPS or cron dies, Healthchecks emails/Telegrams the operator. |

---

## Recommended VPS Layout

```
/etc/caddy/Caddyfile                          # one fronting proxy, three site blocks
/etc/systemd/system/
  ├── kuma.service                            # docker or native
  ├── netdata.service                         # installer-managed
  ├── ops-bridge.service                      # custom unit, see below
  └── (n8n.service exists already — untouched)

/opt/ops-bridge/                              # the new code
  ├── package.json
  ├── src/
  │   ├── server.ts                           # entrypoint, binds 127.0.0.1:8787
  │   ├── routes/host.ts                      # GET /host  -> traffic light JSON
  │   ├── routes/n8n.ts                       # GET /n8n   -> recent runs JSON
  │   ├── clients/netdata.ts                  # http://127.0.0.1:19999/api/v1/...
  │   ├── clients/n8n.ts                      # http://127.0.0.1:5678/api/v1/...
  │   ├── cache.ts                            # in-memory TTL cache
  │   └── auth.ts                             # X-Bridge-Key middleware
  └── .env                                    # BRIDGE_API_KEY, N8N_API_KEY, ports

/var/lib/kuma/                                # docker volume or bind mount for Kuma SQLite
/var/log/                                     # NOT used — everything goes to journald
/etc/cron.d/healthcheck-deadman               # curl https://hc-ping.com/<uuid> every 5m
```

### Ports (post-deploy state)

| Port | Bind | Process | Internet-facing? |
|------|------|---------|------------------|
| 80 | 0.0.0.0 | Caddy | yes (redirect to 443) |
| 443 | 0.0.0.0 | Caddy | yes |
| 3001 | 127.0.0.1 | Uptime Kuma | no (only Caddy talks to it) |
| 8787 | 127.0.0.1 | ops-bridge | no |
| 19999 | 127.0.0.1 | Netdata | no |
| 5678 | 127.0.0.1 | n8n (existing) | depends on current setup — leave as-is |

### Logs

All four new services log to `journald`. One destination, one tool (`journalctl -u <unit> -f`). No `/var/log/*.log` files to rotate. Kuma in Docker logs go to journald via the Docker journald driver — set `--log-driver=journald` in the systemd unit. ([systemd vs PM2 comparison, 2026 — Oxmgr / Cloudbees](https://oxmgr.empellio.com/blog/process-manager-comparison))

### Process supervisor: systemd, not PM2

Recommendation: **systemd** for all three new units. Rationale: systemd is already running, journald is already running, and adding PM2 introduces a second restart layer with its own quirks. PM2's value props (cluster mode, zero-downtime reload) do not apply here — the bridge is a single instance and a 200ms restart is invisible. ([Cloudbees: Running Node.js on Linux with systemd](https://www.cloudbees.com/blog/running-node-js-linux-systemd), [Oxmgr 2026 comparison](https://oxmgr.empellio.com/blog/process-manager-comparison))

---

## Reverse-Proxy Topology

**One fronting proxy. Caddy. Per-subdomain exposure, not per-path.**

### Caddyfile sketch

```
kuma.rmtnetworks.com {
    reverse_proxy 127.0.0.1:3001
    # WebSocket Upgrade/Connection headers are handled automatically by Caddy
}

bridge.rmtnetworks.com {
    reverse_proxy 127.0.0.1:8787
    # bridge enforces X-Bridge-Key itself; Caddy just terminates TLS
}

# existing site blocks for n8n etc. left untouched
```

### Why subdomains, not paths

Uptime Kuma explicitly **does not support being served under a subpath** like `example.com/kuma` — it requires a domain or subdomain. ([Uptime Kuma Wiki — Reverse Proxy](https://github.com/louislam/uptime-kuma/wiki/Reverse-Proxy)) That decision cascades: once Kuma needs its own subdomain, putting the bridge on a parallel subdomain is more consistent than path-mounting only the bridge.

### Why Caddy, not Nginx/Traefik

- **Automatic HTTPS** with Let's Encrypt out of the box, no certbot cron. ([Caddy docs — reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy))
- **WebSocket support is transparent** — no explicit `Upgrade`/`Connection` header config needed, which removes the single most common Kuma-behind-proxy gotcha. ([Uptime Kuma Reverse Proxy Setup — DeepWiki](https://deepwiki.com/louislam/uptime-kuma-wiki/3.1.1-reverse-proxy-setup))
- **One small text file** is the entire config. Solo operator, one host: zero reason for Traefik's dynamic-discovery machinery.
- Nginx is also fine and a valid alternative, but it pays a config-verbosity tax and a certbot-management tax that Caddy avoids.

### What's internet-facing vs localhost-only

| Surface | Exposure | Reason |
|---------|----------|--------|
| Caddy :443 | public | sole TLS terminator |
| Kuma status page (read-only) | public via `kuma.rmt.../status/<slug>` | dashboard iframes it; needed for embedded view |
| Kuma admin UI (`/dashboard`) | public path, but credentialed login | Kuma's own auth is sufficient; do **not** double-gate with basic auth, it breaks the WebSocket login flow |
| Bridge `/host`, `/n8n` | public via `bridge.rmt...`, but requires `X-Bridge-Key` | Netlify function holds the key |
| Netdata UI/API | **localhost only** | bridge scrapes it from `127.0.0.1`; never expose Netdata directly |
| n8n UI | unchanged by this project | leave whatever auth/exposure already exists |
| n8n REST API | localhost only (bridge calls `127.0.0.1:5678`) | API key never leaves the box |

### Embedding Kuma in an iframe

Kuma blocks iframe embedding by default (X-Frame-Options: sameorigin). To allow `rmtnetworks.com` to iframe `kuma.rmt...`, set the environment variable `UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN=true` on the Kuma container/process. ([Uptime Kuma iFrame Support — chillweb.net](https://www.chillweb.net/uptime_kuma/iframe_support), [Cloudpap: Uptime Kuma X-Frame-Options](https://cloudpap.com/blog/uptime-kuma-x-frame-options-integration/))

---

## Auth Model (per surface)

| Surface | Recommended auth | Why |
|---------|------------------|-----|
| Dashboard page on `rmtnetworks.com/ops` | **Netlify basic auth** (single shared password, set in `_headers` or via Netlify Identity-less basic auth on the path) | Matches PROJECT.md constraint; one password for the whole ops view |
| Netlify `ops-proxy` function | inherits basic-auth gate from the dashboard path; additionally holds `BRIDGE_API_KEY` as a server-side env var | Key never reaches the browser |
| Bridge `/host`, `/n8n` | **Static API key** in `X-Bridge-Key` header, validated by middleware; reject everything else with 401 | Single consumer (the Netlify function). Cookies/JWT would be overkill. |
| Uptime Kuma admin (`/dashboard`) | **Kuma's built-in username/password** + (optional) Kuma 2FA | Don't double-gate with basic auth at proxy — it interferes with Kuma's WebSocket login. The Kuma login is the gate. |
| Uptime Kuma status page | **public, read-only** | Needed so the dashboard iframe works for the operator without a second login layer. The status page exposes only what you publish on it — keep it operationally meaningful, not secret. |
| Kuma push/heartbeat URLs | **token in URL** (Kuma's default, `https://kuma.rmt.../api/push/<long-random-token>`) | n8n posts to it on workflow success; token is the only secret needed |
| Netdata API | **no auth, but bound to 127.0.0.1** | Network-level isolation > app-level auth. Never expose Netdata publicly. (Per [Netdata securing-agents docs](https://learn.netdata.cloud/docs/netdata-agent/configuration/securing-agents), the default and recommended posture is to bind to the local interface.) |
| n8n REST API | **`X-N8N-API-KEY` header**, key generated in n8n Settings | Required by n8n; bridge stores it in `.env`. ([n8n API authentication](https://docs.n8n.io/api/authentication/)) |
| Telegram alerts | bot token + chat ID in Kuma's notification settings | Kuma is the only thing that talks to Telegram |

**Recommendation NOT to add IP allowlisting** on the bridge subdomain. The operator works from changing networks; static API key + HTTPS is sufficient at this stake level.

---

## Data Flow (word diagrams)

### Flow 1: Operator opens the dashboard

```
Browser
  -> GET https://rmtnetworks.com/ops              (Netlify basic-auth challenge)
  <- 200 HTML
HTML loads:
  (a) <iframe src="https://kuma.rmtnetworks.com/status/main">
        Browser  -> Caddy  -> Kuma :3001  (WebSocket upgrade)
        Kuma renders status page, live-updates monitor states over the socket
  (b) fetch("/.netlify/functions/ops-proxy/host")
        Browser -> Netlify edge function
        Function -> GET https://bridge.rmt.../host  with X-Bridge-Key
                    Caddy -> bridge :8787
                    bridge -> (cache hit?  return) | (miss?  GET 127.0.0.1:19999/api/v1/data?chart=system.cpu&...)
                    bridge -> distill to {status:"green|yellow|red", cpu, mem, disk, net}
        Function <- JSON, Function returns it to browser
  (c) fetch("/.netlify/functions/ops-proxy/n8n")
        Same shape; bridge calls GET 127.0.0.1:5678/api/v1/executions?limit=20 with X-N8N-API-KEY
```

**Direction:** Pull for everything user-initiated. The browser pulls, the function pulls, the bridge pulls. No pushes in this flow.

### Flow 2: Critical n8n workflow completes (heartbeat)

```
n8n workflow runs to its "success" branch
  -> HTTP Request node:  GET https://kuma.rmtnetworks.com/api/push/<token>?status=up&msg=ok&ping=
       (note: the call leaves the VPS via Caddy, not loopback — this is intentional;
        it validates that the public ingress path is alive too)
  Caddy -> Kuma :3001
  Kuma marks the push monitor as "up" and resets the heartbeat-missed timer
```

**Direction:** Push (from n8n into Kuma). If the heartbeat doesn't arrive within the configured window, Kuma flips the monitor to DOWN on its own.

### Flow 3: Kuma detects a monitor down

```
Kuma probe loop fires (active monitor) OR heartbeat timer expires (push monitor)
  -> monitor state transitions UP -> DOWN
  -> Kuma's notification dispatcher iterates configured notifiers
  -> Telegram notifier: HTTPS POST https://api.telegram.org/bot<token>/sendMessage
  -> Telegram delivers to the operator's chat
```

**Direction:** Push, originated by Kuma, outbound only. Nothing about the VPS's network needs to accept inbound from Telegram.

### Flow 4: Bridge polls n8n + serves dashboard

```
Bridge process (idle until a request arrives)
  Browser/Function -> GET /n8n
  -> auth.ts validates X-Bridge-Key
  -> cache.get("n8n:recent") -> miss (TTL 60s expired)
  -> clients/n8n.ts:
       GET http://127.0.0.1:5678/api/v1/executions?limit=20
       headers: X-N8N-API-KEY: <key>
  -> shape response:  [{id, workflowName, status, startedAt, durationMs}, ...]
  -> cache.set("n8n:recent", payload, 60s)
  -> respond 200 JSON
```

**Direction:** Pull, lazy. The bridge does NOT poll n8n on a timer — it pulls on demand and caches. This is cheaper and avoids stale data after a long idle period.

**Trade-off acknowledged:** if the operator hasn't loaded the dashboard for an hour and a workflow just failed, the bridge has no cached signal. That's fine — Kuma + Telegram is the path that alerts on failure. The bridge serves a "what just happened?" view, not the alerting pipeline.

---

## CORS Decision

**Recommendation: route through Netlify functions. Do NOT put CORS headers on the bridge.**

### Rationale

1. **The site already uses Netlify functions as a proxy layer** (per `memory/project_rmtnetworks.md` and the existing Supabase pattern). Adding `ops-proxy` is the same shape the operator already maintains — one less mental model.
2. **Keeps `BRIDGE_API_KEY` server-side.** If the browser called the bridge directly, the key would have to live in the browser (or be omitted, which weakens the bridge to "security by obscure subdomain"). The function model means the key sits in a Netlify env var and never crosses the public/private boundary.
3. **No preflight headaches.** Same-origin fetches from `rmtnetworks.com` to `/.netlify/functions/*` are origin-of-page calls — no CORS at all.
4. **Cheap.** The two endpoints are called every 30–60s by one user. Netlify's free-tier function quota swallows this without strain.

### Why NOT CORS-on-bridge

- Would require shipping the API key to the browser (bad) or running unauthenticated (worse).
- `Access-Control-Allow-Origin: https://rmtnetworks.com` would have to be maintained alongside Netlify deploy previews and any future custom domains — extra config drift surface.
- The bridge stays single-purpose: "respond JSON to authenticated server-side callers." Easier to reason about.

---

## Build Order

```
PHASE A (parallel, no dependencies on each other):
  A1. Install Caddy on the VPS, point kuma.rmt... DNS, get a placeholder site block
      responding so we know TLS works.
  A2. Generate an n8n API key in n8n Settings and put it in a password store.
  A3. Generate BRIDGE_API_KEY (random 32+ chars) and put it in Netlify env vars
      (paste it now, even before the bridge exists — Netlify deploys are independent).

PHASE B (sequential within B, but B can start as soon as A1 is green):
  B1. Deploy Uptime Kuma (Docker via systemd unit), 127.0.0.1:3001,
      env UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN=true.
  B2. Add Caddy site block kuma.rmt... -> 127.0.0.1:3001, reload Caddy, verify HTTPS + WS.
  B3. In Kuma: create admin account, configure Telegram notifier, add the first monitor
      (Supabase health endpoint) and confirm a manual "down" test triggers Telegram.
      -> EXIT GATE: Telegram alert proven end-to-end before adding more monitors.

PHASE C (parallel with B once A1 done):
  C1. Install Netdata native (`kickstart.sh --disable-cloud`).
  C2. Edit netdata.conf -> [web] bind to = 127.0.0.1, restart, confirm
      `curl http://127.0.0.1:19999/api/v1/info` works locally and
      `curl https://<vps-public>:19999` does NOT.

PHASE D (depends on B1 + C2 being healthy; A2 + A3 available):
  D1. Scaffold /opt/ops-bridge, write routes/host.ts against Netdata API
      (chart=system.cpu, system.ram, disk.space, net.<iface>).
  D2. Write routes/n8n.ts against http://127.0.0.1:5678/api/v1/executions.
  D3. Add auth.ts middleware, systemd unit, start it, bind 127.0.0.1:8787.
  D4. Add Caddy site block bridge.rmt... -> 127.0.0.1:8787, reload.
  D5. Curl-verify both endpoints over HTTPS with and without the key (200 vs 401).

PHASE E (depends on D5):
  E1. Write Netlify function ops-proxy that forwards /host and /n8n.
  E2. Write the dashboard HTML page that iframes Kuma and renders the two JSON payloads.
  E3. Add basic-auth gate to the /ops path in Netlify config.
  E4. Deploy. Test from a browser that has never seen this site.

PHASE F (parallel with E, depends only on B3):
  F1. In each critical n8n workflow, add an HTTP Request node on the success branch
      that GETs the Kuma push URL.
  F2. In Kuma, create a corresponding "Push" monitor per workflow with an appropriate
      "heartbeat interval" + "retries" matching that workflow's cadence.
  F3. Force-fail one workflow once; confirm Telegram fires when the heartbeat is missed.

PHASE G (depends on B3 working at minimum):
  G1. Create a Healthchecks.io check (free tier).
  G2. Cron on the VPS: every 5 min, curl https://hc-ping.com/<uuid>.
  G3. Configure Healthchecks to email + Telegram (via its own bot) if the ping is late.
       -> This is the ONLY component intentionally NOT on the VPS.
```

### What can parallelize, what can't

- **Parallel:** A1/A2/A3 are independent. C (Netdata) is fully independent of B (Kuma). E (dashboard) and F (heartbeats) can run side by side once D is done.
- **Strictly sequential:** B1 → B2 → B3 (you cannot configure Kuma until Kuma is reachable; you cannot trust monitors until Telegram is proven). D depends on Netdata + Kuma being up because the host endpoint reads Netdata and you want at least one Kuma monitor to know "is the box healthy from outside" while you build. E depends on D because there is nothing to proxy until the bridge exists.
- **The exit gate that matters most:** B3. Do not proceed to add ten monitors before confirming one Telegram alert actually arrives. Every extra monitor added before that gate just multiplies debugging if Telegram is misconfigured.

---

## Failure Isolation

### If the bridge crashes

- **Dashboard impact:** `/.netlify/functions/ops-proxy/host` returns 502/timeout. The two custom panels render an error state ("bridge unreachable").
- **The iframe (Kuma status page) keeps working** — it talks to Kuma directly, not through the bridge. So the operator still sees up/down for everything Kuma monitors.
- **Detection:** Kuma itself has an HTTP monitor pointed at `https://bridge.rmt.../healthz` (the bridge exposes an unauthenticated, trivially-cheap `/healthz` that returns `{ok:true}` — separate from `/host` and `/n8n` so its failure mode is independent of Netdata or n8n being slow). When `/healthz` fails twice in a row, Kuma fires Telegram.
- **Recovery:** systemd `Restart=on-failure` + `RestartSec=5` brings it back automatically. The Kuma alert tells the operator if it kept failing.

### If Kuma goes down

- **Dashboard impact:** the iframe shows a broken page. The bridge panels still work.
- **Alerting impact:** **no Telegram alerts will fire**, because Kuma is the alerter. This is the classic watch-the-watcher problem.
- **Detection — primary:** The external Healthchecks.io dead-man's-switch (see Phase G). A cron on the VPS pings Healthchecks every 5 minutes; if the VPS or its cron is dead, Healthchecks alerts the operator independently. ([Healthchecks.io](https://healthchecks.io/), [Hartwork — Uptime monitoring with Healthchecks.io](https://blog.hartwork.org/posts/uptime-monitoring-with-healthchecksio-is-possible/))
- **Detection — secondary (optional but cheap):** Healthchecks.io also offers normal HTTP uptime checks. Pointing one at `https://kuma.rmt.../api/status-page/heartbeat/<slug>` (a public Kuma endpoint that returns 200 when Kuma is alive) catches "VPS up, Kuma down" specifically, which the dead-man's-switch cron would miss.
- **Recovery:** systemd `Restart=always` for the Kuma unit. If Kuma is in a crash loop, the Healthchecks alert is the signal to SSH in and read `journalctl -u kuma`.

### If the VPS is wholly down

- Healthchecks.io dead-man's-switch fires (no ping arrives → late → alert).
- This is the single non-VPS dependency in the entire architecture and the reason to keep it.

### If Netdata goes down but Kuma is up

- The bridge `/host` endpoint returns degraded ("netdata unreachable, traffic light = unknown / yellow"). Dashboard renders a yellow tile with an explanation rather than failing.
- Kuma's host-capacity alerts (disk, RAM) that are configured as **Kuma monitors directly against Netdata's API on 127.0.0.1** would also fail — and Kuma would Telegram-alert on those monitors going down. So Netdata's death is observable.

### If Netlify is down

- The dashboard URL is unreachable, but **alerting (Kuma → Telegram) is unaffected** because it runs entirely on the VPS. The operator can still get paged; they just can't open the at-a-glance view until Netlify is back.
- This is acceptable given the project's stated value: "Telegram is the pager; the dashboard is the daily check-in."

### Summary: the watch-the-watcher loop

```
Healthchecks.io  ◄── (cron every 5m) ── VPS
       │
       └── if ping is late → email + Telegram (via its own bot, not Kuma's)

Kuma  ── (HTTP monitor) ──► bridge /healthz   → alerts if bridge dies
Kuma  ── (HTTP monitor) ──► Netdata 127.0.0.1 → alerts if Netdata dies
Kuma  ── (HTTP monitor) ──► Supabase, n8n     → alerts on real ops failures
Kuma  ── (Push monitor) ──◄ heartbeat from n8n workflows  → alerts on workflow staleness

Kuma is watched by Healthchecks.io.        ← this is the only off-host dependency
Healthchecks.io is watched by... nobody.    ← acceptable; they have their own uptime team
```

---

## Architectural Patterns

### Pattern 1: Server-side proxy with injected secret (Netlify Functions)

**What:** Browser never sees the bridge API key. The Netlify function holds it as an env var and injects it on the server side.
**When to use:** Any time you have a static API key and a static caller; do NOT ship the key to the browser.
**Trade-offs:** +1 extra hop (browser → Netlify → bridge), but the hop is at edge speed and avoids both CORS and key exposure.

```typescript
// netlify/functions/ops-proxy.ts (sketch)
export const handler = async (event) => {
  const subpath = event.path.split("/ops-proxy/")[1]; // "host" or "n8n"
  if (!["host", "n8n"].includes(subpath)) return { statusCode: 404 };
  const res = await fetch(`https://bridge.rmtnetworks.com/${subpath}`, {
    headers: { "X-Bridge-Key": process.env.BRIDGE_API_KEY! },
  });
  return {
    statusCode: res.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: await res.text(),
  };
};
```

### Pattern 2: Lazy pull-through cache (the bridge)

**What:** The bridge does not poll upstream on a timer. It fetches when a request arrives, caches the result for a short TTL (30–60s), and serves cached responses to subsequent requests until the TTL expires.
**When to use:** Read endpoints with a single low-frequency consumer where freshness > a minute is acceptable.
**Trade-offs:** First request after idle pays the upstream cost; protects upstream from request storms; eliminates the need for a background job.

### Pattern 3: Loopback-only data plane, proxy-only control plane

**What:** Every internal component binds to `127.0.0.1`. Only Caddy binds to `0.0.0.0`. Components talk to each other over loopback.
**When to use:** Single-host deployments. It is the default for Netdata, fine to enforce for Kuma and the bridge.
**Trade-offs:** If you later split services across hosts you have to redo it — but that's a 10-line Caddyfile and unit-file change, not an architecture change.

### Pattern 4: Two-channel workflow monitoring (push heartbeat + pull history)

**What:** For each critical n8n workflow, configure both a Kuma push monitor (workflow pings Kuma on success) AND let the bridge pull recent executions from n8n's API.
**When to use:** When alerting and visualization have different needs — alerting wants bulletproof "did this specific run succeed", visualization wants a feed.
**Trade-offs:** Two integration points to maintain per workflow. Mitigation: heartbeat is one HTTP Request node copy-pasted into each workflow's success branch.

---

## Anti-Patterns

### Anti-Pattern 1: Exposing Netdata publicly to read it from the browser

**What people do:** Put Netdata behind Caddy at `netdata.example.com`, log in once, leave it accessible.
**Why it's wrong:** Netdata exposes deep host telemetry, has historically not been built to be an internet-facing dashboard, and the official docs recommend binding to a private/local interface as the primary security model. ([Netdata — Securing Agents](https://learn.netdata.cloud/docs/netdata-agent/configuration/securing-agents))
**Do this instead:** Keep Netdata on 127.0.0.1, have the bridge be the one and only client, expose a distilled traffic-light JSON.

### Anti-Pattern 2: Putting basic auth in front of Kuma at the proxy

**What people do:** Wrap Caddy basic auth around `kuma.rmt...` "for extra security."
**Why it's wrong:** Kuma uses WebSockets for its admin login and live UI. A proxy-level basic-auth challenge interferes with the WebSocket handshake and you'll spend an evening debugging a "white screen after login." Kuma's own login is already a username/password gate.
**Do this instead:** Trust Kuma's auth for the admin UI. Keep the status page public (it's designed to be). Use Kuma's optional 2FA if paranoid.

### Anti-Pattern 3: Background pollers for the bridge data

**What people do:** Spin up a `setInterval(fetchNetdata, 5000)` in the bridge so the latest data is "always ready."
**Why it's wrong:** Wastes CPU and network when nobody's looking, complicates failure modes (poller crashes silently), and adds state to a stateless service.
**Do this instead:** Lazy pull-through cache. The dashboard polls every 30–60s; that triggers the bridge to refresh on a TTL. If nobody's looking, nothing happens.

### Anti-Pattern 4: Co-locating the dead-man's-switch on the VPS

**What people do:** Run a "Kuma is alive" check from the same VPS Kuma lives on.
**Why it's wrong:** When the VPS dies, the check dies too, and you find out from a confused user, not a pager.
**Do this instead:** Use an off-host service (Healthchecks.io free tier is sufficient) for the single dead-man's-switch ping. This is the entire reason it exists.

### Anti-Pattern 5: Storing the bridge API key in the browser

**What people do:** Hard-code it in the dashboard JS so the bridge can be hit directly, then "protect" it with CORS allowlist.
**Why it's wrong:** Keys in browser code are public. CORS is not a security control against direct HTTP clients. Anyone who views source gets the key.
**Do this instead:** Bridge has a server-side caller (Netlify function). Key lives in Netlify env vars.

---

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Telegram | Kuma → Bot API (outbound HTTPS) | Bot token + chat ID configured in Kuma. No inbound needed. |
| Supabase | Kuma HTTP(s) monitor → public health/REST endpoint | One monitor; alerting only — Supabase is not state for this project. |
| Healthchecks.io | Cron on VPS → ping URL (outbound HTTPS) | The one off-host dependency. |
| Let's Encrypt | Caddy automatic ACME | No operator action required. |
| Netlify | Dashboard host + serverless proxy | Already in use; this project just adds one function + one page + a basic-auth header. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Browser ↔ Netlify | HTTPS, basic-auth gated | Same-origin for function calls, no CORS |
| Netlify function ↔ Bridge | HTTPS over public DNS, `X-Bridge-Key` header | Going out to the internet and back; acceptable because the function isn't on the VPS |
| Bridge ↔ Netdata | HTTP on 127.0.0.1 | No auth; loopback is the trust boundary |
| Bridge ↔ n8n | HTTP on 127.0.0.1, `X-N8N-API-KEY` header | Loopback + key |
| Kuma ↔ monitored targets | Outbound HTTPS (Supabase, etc.) and inbound HTTP push (heartbeats from n8n via public path) | The heartbeat going through Caddy is deliberate — it round-trips the public ingress |
| Kuma ↔ Telegram | Outbound HTTPS | One way |
| systemd ↔ all units | local | journald collects logs from all three new units |

---

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 1 operator, 1 VPS (today) | Current design as written. |
| 1 operator, 1 VPS, ~50 monitors + 10 workflows | No change. Kuma and Netdata both comfortably handle this on modest hardware. Bridge cache stays at 60s. |
| 1 operator, 2 VPS | Add a second Netdata agent on the new VPS; add Kuma monitors for the second box; Kuma stays on the original VPS. The bridge gets a `host?node=<name>` query param. Caddy unchanged. |
| 2+ operators | Replace Netlify basic auth with Netlify Identity or stick a real auth provider in front; consider splitting `/ops` into per-role views. Out of current scope. |
| Multi-tenant or customer-facing status page | Different problem; out of scope per PROJECT.md. |

### First bottleneck

The first thing that breaks at "more monitors" is **disk I/O for Kuma's SQLite** under very fast monitor intervals. Mitigation: don't set monitor intervals below 30s unless you need to; that's already the Kuma default for good reason.

### Second bottleneck

Telegram rate limiting (~30 messages/sec per bot, ~1 message/sec per chat). Irrelevant at solo-operator scale but worth knowing.

---

## Sources

- [Uptime Kuma Wiki — Reverse Proxy](https://github.com/louislam/uptime-kuma/wiki/Reverse-Proxy) — HIGH (official wiki)
- [Uptime Kuma Wiki — Status Page](https://github.com/louislam/uptime-kuma/wiki/Status-Page) — HIGH (official wiki)
- [Uptime Kuma Reverse Proxy Setup — DeepWiki](https://deepwiki.com/louislam/uptime-kuma-wiki/3.1.1-reverse-proxy-setup) — MEDIUM (wiki mirror)
- [chillweb.net — iFrame Support for Uptime Kuma](https://www.chillweb.net/uptime_kuma/iframe_support) — MEDIUM (community doc on UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN)
- [Cloudpap — Uptime Kuma X-Frame-Options Integration](https://cloudpap.com/blog/uptime-kuma-x-frame-options-integration/) — MEDIUM (corroborating source for iframe config)
- [Netdata — Securing Agents](https://learn.netdata.cloud/docs/netdata-agent/configuration/securing-agents) — HIGH (official docs)
- [Netdata — Web Server Configuration Reference](https://learn.netdata.cloud/docs/agent/web/server) — HIGH (official docs; `web.bind to`)
- [n8n — API Authentication](https://docs.n8n.io/api/authentication/) — HIGH (official docs; `X-N8N-API-KEY`)
- [n8n — API Reference](https://docs.n8n.io/api/api-reference/) — HIGH (official docs; `/api/v1/executions`)
- [Caddy — reverse_proxy directive](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) — HIGH (official docs; transparent WebSocket)
- [Caddy — Reverse proxy quick-start](https://caddyserver.com/docs/quick-starts/reverse-proxy) — HIGH (official docs)
- [Healthchecks.io](https://healthchecks.io/) — HIGH (official; dead-man's-switch pattern)
- [Hartwork Blog — Uptime monitoring with Healthchecks.io](https://blog.hartwork.org/posts/uptime-monitoring-with-healthchecksio-is-possible/) — MEDIUM (corroborating pattern source)
- [Cloudbees — Running Node.js on Linux with systemd](https://www.cloudbees.com/blog/running-node-js-linux-systemd) — MEDIUM (systemd unit guidance)
- [Oxmgr 2026 — Process Manager Comparison: PM2, systemd, supervisor](https://oxmgr.empellio.com/blog/process-manager-comparison) — MEDIUM (current systemd vs PM2 framing)

---
*Architecture research for: solo-operator self-hosted monitoring console (Kuma + Netdata + Node bridge + Netlify dashboard)*
*Researched: 2026-05-16*
