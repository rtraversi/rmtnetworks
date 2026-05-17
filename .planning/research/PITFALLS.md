# Pitfalls Research

**Domain:** Solo-operator self-hosted monitoring console (Uptime Kuma + Netdata + Node.js bridge on one VPS, alerts to Telegram, dashboard embedded on Netlify)
**Researched:** 2026-05-16
**Confidence:** HIGH for documented behaviors (Uptime Kuma, n8n, Netlify, Netdata config flags), MEDIUM for threshold/tuning recommendations (synthesized from community sources, not formal benchmarks)

---

## Critical Pitfalls

### Pitfall 1: Alert fatigue from over-eager defaults on day one

**What goes wrong:**
You wire up Uptime Kuma with default 60-second checks, 1-retry threshold, and Telegram on every monitor. Within 48 hours Telegram becomes background noise: brief network blips fire "down → up" pairs, Supabase's free-tier cold starts trip ping monitors, CPU bursts from cron jobs trigger Netdata "high CPU" alerts. You mute the chat. The next real outage arrives muted.

**Why it happens:**
Defaults are tuned for "see everything," not "page me when it matters." Single-channel Telegram has no severity layering, no business-hours suppression, and no de-dup. Solo operators don't have a quieter on-call channel to absorb noise.

**How to avoid:**
Adopt a **two-tier alert plan** from monitor #1:
- **Page-worthy** (Telegram, sound on): hard down ≥ 3 consecutive failures, disk ≥ 95%, RAM sustained ≥ 95% for 10+ minutes, missed critical heartbeat after grace.
- **FYI** (Telegram silent, or separate "low-prio" chat): disk 90%, RAM 85% for 30+ min, slow response time, non-critical workflow failure.

Concrete Uptime Kuma settings to start with:
- HTTP monitor interval: **60s**, retries: **3**, retry interval: **60s** → flap protection ~3 min before any alert.
- Push (heartbeat) monitor interval: set to **2x expected workflow cadence** (e.g., workflow runs hourly → heartbeat interval 7200s), retries: **1**, so one missed run only alerts after the second miss.
- Use Telegram's `disable_notification` for "FYI" monitors (in Uptime Kuma the equivalent is creating a second notification provider with "Silent" enabled and assigning it to non-critical monitors).
- Disable per-monitor notifications on anything not in the page-worthy list.

**The "first two weeks" convergence plan:**
- **Days 1–3:** Everything alerts loudly. Goal is to find the noisy ones.
- **End of day 3:** For each alert received, decide: was this actionable? If no → demote to silent OR raise the threshold OR add retries. Write the decision in a one-line log (`.planning/alert-log.md`).
- **Days 4–10:** Repeat daily. After each false positive, tune one knob.
- **Day 14:** Re-audit. The goal is **zero non-actionable alerts in the last 72 hours**. If you're still getting noise, you have too many monitors or thresholds are still too tight.

**Warning signs:**
- More than ~2 Telegram pings per day in the first week and you haven't acted on any of them.
- You catch yourself unlocking the phone and dismissing the notification without reading it.
- "Down → Up" pairs within 60 seconds appearing more than once a day.

**Phase to address:**
**Phase 1 (Kuma + Telegram baseline)** — define the two-tier policy before adding the first monitor. **Phase 4 (Tune & Polish)** — the explicit two-week convergence audit.

---

### Pitfall 2: Heartbeat says green, workflow actually failed

**What goes wrong:**
A critical n8n workflow has a heartbeat ping at the end. The workflow "succeeds" — no error thrown — but it produced wrong output: empty array, stale data, fallback branch silently taken. The heartbeat fires. Kuma shows green. You only notice three days later when a downstream consumer complains.

**Why it happens:**
- The heartbeat is placed at the end of the workflow rather than at the end of a **specific success branch**.
- The workflow uses "Continue on Fail" or default values, swallowing the real failure.
- The heartbeat URL is hit unconditionally rather than gated on a validation node.

**How to avoid:**
Three concrete rules for every heartbeat:

1. **Validate before pinging.** Place an `IF` node immediately before the heartbeat HTTP Request node. The condition must assert that the workflow produced the expected output (row count > 0, expected field present, status == "ok"). Only the "true" branch pings the success URL.

2. **Use separate `status=up` and `status=down` URLs.** Uptime Kuma's push monitor accepts `?status=up&msg=ok` and `?status=down&msg=...` query parameters. The "false" branch of the validation IF should ping `?status=down&msg=validation_failed` so Kuma immediately marks the monitor down rather than waiting for a missed heartbeat. ([Uptime Kuma push monitor docs](https://github.com/louislam/uptime-kuma/wiki))

3. **Set heartbeat interval = 2x cadence, retries = 1.** A workflow that runs hourly should have a heartbeat monitor with interval ~7200s and 1 retry. One miss is "pending," two misses is "down." This gives a grace period without requiring a separate config (Uptime Kuma has no first-class grace-period field — retries are the mechanism). ([Uptime Kuma issue #2445 — grace period via retries](https://github.com/louislam/uptime-kuma/issues/2445))

**Wrong-output detection (the harder case):**
For workflows where "succeeded but produced garbage" is plausible, add a **shadow check**:
- A separate Kuma HTTP monitor that polls a Supabase view or API endpoint the workflow is supposed to update.
- If the timestamp on that record is older than `2 * cadence`, the monitor goes down.
- This is the only way to catch "heartbeat green, reality red" — the data itself becomes the source of truth.

**Warning signs:**
- Heartbeat monitor is 100% green over a long period but you have no audit log of what each "success" actually did.
- The workflow contains `continueOnFail: true` on any node before the heartbeat.
- The heartbeat is the very last node in the workflow regardless of branch.

**Phase to address:**
**Phase 2 (n8n heartbeats)** — every heartbeat must use the validation-IF pattern. **Phase 3 (n8n API bridge)** — implement at least one shadow-check monitor for the most critical workflow.

---

### Pitfall 3: Watching the watcher — VPS dies, no alert fires

**What goes wrong:**
The VPS hosting Kuma also hosts everything Kuma monitors. If the VPS itself dies (hardware failure, network partition, provider outage, OOM killing Kuma), no alerts fire because Kuma is dead. You learn about the outage from a customer or by noticing the dashboard hasn't updated when you check it casually.

**Why it happens:**
Self-hosted monitoring on the same host as the monitored services is a known antipattern, but it's the natural starting point for solo operators because the alternative feels like "more infrastructure to manage."

**How to avoid (proportionate to solo operator):**
Use a **single free external dead-man's-switch** — this is the right scale of mitigation. Anything more is overkill.

**Recommended: healthchecks.io free tier.**
- Free for up to 20 checks, no credit card.
- Create one check called "kuma-alive" with a 5-minute schedule and a 1-minute grace.
- On the VPS, cron job: `* * * * * curl -fsS --retry 3 https://hc-ping.com/<uuid> > /dev/null` (runs every minute, healthchecks expects a ping within 6 minutes).
- Configure healthchecks.io to notify your Telegram (separate from the Kuma bot, or same — your call) when the check goes red.
- If the VPS dies, the cron stops pinging, healthchecks.io fires within ~6 minutes.

**What's overkill at this scale:**
- A second VPS running another Kuma instance — you've doubled the surface area to manage.
- UptimeRobot/BetterStack free tiers — fine, but healthchecks.io is cleaner because it's pull-based (your VPS pings out); you don't need to expose a public HTTP endpoint for the outside world to check.
- Cloudflare Workers cron monitor — fine if you already use Cloudflare, but adds a new tool for a 5-line problem.
- StatusCake, Pingdom, Datadog Synthetics — way overkill.

**Important nuance:**
The external check should ping a script on the VPS that **actually verifies Kuma is up**, not just that the VPS is up. Example:
```bash
#!/bin/bash
# /usr/local/bin/kuma-alive.sh
if curl -fsS -o /dev/null -w "%{http_code}" http://localhost:3001/api/status-page/heartbeat/default | grep -q 200; then
  curl -fsS --retry 3 https://hc-ping.com/<uuid>
fi
```
Cron this every minute. If Kuma's process dies but the VPS lives, you still get an alert.

**Warning signs:**
- You don't have any monitor outside your VPS.
- You can't answer "how would I know if the VPS was unreachable from the internet right now?" without checking the VPS yourself.

**Phase to address:**
**Phase 1 (Kuma + Telegram baseline)** — set up the external dead-man's-switch in the same phase Kuma goes live. Do not defer.

---

### Pitfall 4: Resource contention — Netdata/Kuma/bridge starve n8n

**What goes wrong:**
You add Kuma, Netdata, and the bridge to a VPS already running n8n (and whatever else). After a few weeks:
- Netdata's default 1-second sample rate is collecting thousands of metrics; on a small VPS it can use 200–500 MB RAM steady-state and spike higher during compaction.
- Kuma's SQLite has grown to hundreds of MB and DB writes contend with n8n's database.
- The bridge polls n8n's API every minute and on a busy n8n instance the executions endpoint response can be 5–20 MB; each call eats CPU and memory parsing the JSON.
- n8n executions slow down, workflows that depend on tight timing start failing, and the very monitoring system you built is causing the outages it's reporting.

**Why it happens:**
Default settings of all three tools are tuned for "useful out of the box," not "minimal footprint." On a small VPS (1–4 GB RAM) defaults compete with the workload.

**How to avoid:**

**Netdata footprint reduction** (apply on day one):
- Edit `/etc/netdata/netdata.conf`:
  - `[global] update every = 5` (default 1s; this alone roughly halves CPU; further reductions to 5s halve again per Netdata's own docs).
  - `[db] mode = dbengine`, `[db] dbengine multihost disk space MB = 256` to cap on-disk metrics storage.
  - Disable unused plugins in `/etc/netdata/python.d.conf` and `/etc/netdata/go.d.conf` (e.g., if you don't run nginx, set `nginx: no`).
- Target: < 100 MB RSS for the netdata process on a typical small VPS. ([Netdata community: reducing footprint](https://community.netdata.cloud/t/reduce-memory-footprint-of-netdata-agent/5026)) ([Netdata resource utilization docs](https://learn.netdata.cloud/docs/netdata-agent/resource-utilization))

**Uptime Kuma footprint:**
- Set retention: Settings → General → "Keep monitor history data" → **30 days** (default 180). With ~20 monitors at 60s, this keeps SQLite under ~50 MB.
- Run **"Shrink Database"** (Settings → Backup → Shrink) monthly via cron — SQLite doesn't reclaim space on its own; the VACUUM only happens on demand. ([DeepWiki: Data Management and Backup](https://deepwiki.com/louislam/uptime-kuma/11-data-management-and-backup))
- Cap monitor count at ~25 for the small-VPS scenario. Each adds DB writes and a websocket-bound row in the dashboard payload.

**Bridge footprint:**
- Cache aggressively: poll n8n's executions endpoint at most **once per minute** and serve cached JSON to dashboard requests.
- Use `limit=20` and `fields=id,workflowId,status,startedAt,stoppedAt` on the n8n API call (see Pitfall 5).
- Run as a single Node process, not a worker pool. Memory limit `--max-old-space-size=128` is plenty.

**Sizing rule of thumb (1–2 GB VPS):**
| Component | Target RSS | Hard ceiling |
|-----------|-----------|--------------|
| n8n | 400–700 MB | (already in use) |
| Kuma | 100–200 MB | 300 MB |
| Netdata | 50–100 MB | 150 MB |
| Bridge | 30–60 MB | 100 MB |
| OS + everything else | 200 MB | — |
| **Headroom** | **≥ 300 MB free** | — |

If headroom is < 300 MB, you're one bad workflow execution from OOM-killing n8n.

**Warning signs:**
- `free -m` shows < 200 MB available regularly.
- Netdata's own dashboard shows memory pressure or swap-in events.
- n8n execution times for stable workflows increase by > 20% after the monitoring stack is installed.

**Phase to address:**
**Phase 0 (VPS prep)** — apply the Netdata config trims and set RAM/disk budgets before installing anything. **Phase 4 (Tune & Polish)** — re-measure all four components' RSS and confirm headroom is still ≥ 300 MB.

---

### Pitfall 5: n8n API tarpits — executions endpoint at scale

**What goes wrong:**
The bridge polls `GET /api/v1/executions` every minute to populate the "recent runs" dashboard panel. Initially the response is small. After n8n has been running for a few weeks with workflows that produce binary data or large JSON outputs:
- Each executions list response includes execution metadata (no data by default since v1.x, but still bloats).
- If `includeData=true` was ever set, responses can be 50+ MB.
- The first dashboard load after a deploy hits an uncached endpoint and times out.
- API version drift between n8n releases changes response shapes; the client breaks on upgrade.

**Why it happens:**
- The executions endpoint paginates but the **default page size is large** and most clients fetch all pages.
- The endpoint cost grows with `execution_entity` table size — without pruning, this is unbounded.
- The n8n API is versioned as `/api/v1/` but field semantics have changed across point releases (e.g., `data` field handling, status enum values).

**How to avoid:**

**Always pass narrow filters:**
```
GET /api/v1/executions?limit=20&includeData=false
```
The dashboard only needs the most recent N executions, not everything. ([n8n API pagination guide](https://refactix.com/ai-automation-productivity/n8n-api-pagination-rate-limits-retries))

**Enable n8n execution pruning** (this is the single most important config — without it the `execution_entity` table grows unbounded):
```env
EXECUTIONS_DATA_PRUNE=true
EXECUTIONS_DATA_MAX_AGE=336              # hours = 14 days
EXECUTIONS_DATA_PRUNE_MAX_COUNT=10000
```
Since early 2025 these defaults are on, but **verify on your instance** — older self-hosted setups may have pruning off. Without pruning, Postgres/SQLite balloons by gigabytes in weeks. ([n8n execution data docs](https://docs.n8n.io/hosting/scaling/execution-data/)) ([LumaDock: pruning executions](https://lumadock.com/tutorials/n8n-prune-executions))

**Pin the n8n version in your bridge:**
- The bridge package.json should record which n8n version it was tested against (in a comment or constant).
- Wrap the API client in a thin adapter (`getRecentExecutions()`) so when the API shape changes on upgrade, only one file changes.
- Defensive parsing: never assume a field exists; default missing fields to safe values.

**Rate-limit your own bridge:**
- One in-flight request to n8n at a time; serialize concurrent dashboard loads through a shared in-memory cache with a 30-second TTL.
- If the n8n API call fails or times out, serve stale cache and return a `data.stale: true` flag rather than 500-ing the dashboard.

**API auth:**
- Use n8n API keys (Settings → API), not the deprecated cookie-auth approach.
- Store the key in `.env` on the VPS, **not** in the bridge's git repo. Add to gitignore on day one.

**Warning signs:**
- Bridge requests to n8n taking > 1 second.
- Dashboard "recent runs" panel showing a spinner for > 2 seconds.
- n8n's own UI executions tab is slow (a leading indicator that the executions table is large).
- Bridge logs show JSON parse errors after an n8n upgrade.

**Phase to address:**
**Phase 0 (VPS prep)** — verify `EXECUTIONS_DATA_PRUNE` is on. **Phase 3 (n8n API bridge)** — implement narrow filters, caching, and the adapter pattern from the first commit.

---

### Pitfall 6: Netlify basic auth — protected page, exposed assets and functions

**What goes wrong:**
You add basic auth in `netlify.toml` for the dashboard path. The HTML page is protected. But:
- Static assets (JS bundles, CSS) under different paths are publicly fetchable, leaking dashboard internals.
- The Netlify Functions that proxy to the bridge are **not** automatically behind basic auth — they're at `/.netlify/functions/*` which is a different path scope.
- Someone with the password commits it to the repo by accident in `netlify.toml`.
- You change the password and lose the ability to log in from a device that cached the old credentials weirdly; there's no "forgot password" flow.

**Why it happens:**
- Netlify's site-wide password protection (a paid plan feature) and the `_headers`/`netlify.toml` basic-auth approach behave differently. Path-scoped basic auth only protects what its glob matches.
- Functions are deployed under a separate path and need their own `Basic-Auth` declaration in `netlify.toml`. ([Netlify support forum: post to function behind basic password](https://answers.netlify.com/t/post-to-netlify-function-behind-basic-password-protection/95948)) ([Netlify password protection docs](https://docs.netlify.com/manage/security/secure-access-to-sites/password-protection/))
- Operators paste the credential into config thinking it's safe because the repo is private; but private repos are still readable by anyone who gains access (collaborators, leaked tokens, future-you).

**How to avoid:**

**1. Cover all paths the dashboard touches.** In `netlify.toml`:
```toml
[[headers]]
  for = "/ops/*"
  [headers.values]
    Basic-Auth = "ops:${OPS_PASSWORD}"

[[headers]]
  for = "/.netlify/functions/ops-*"
  [headers.values]
    Basic-Auth = "ops:${OPS_PASSWORD}"
```
Prefix all dashboard-related functions with `ops-` so a single glob covers them.

**2. Never commit the password.** Use Netlify environment variables (`OPS_PASSWORD`) and reference them via `${VAR}` substitution. `netlify.toml` should contain no plaintext credential.

**3. Test the protection comprehensively** before going live. Run a quick smoke test:
```bash
# Should all return 401 without creds:
curl -I https://rmtnetworks.com/ops/
curl -I https://rmtnetworks.com/ops/assets/dashboard.js
curl -I https://rmtnetworks.com/.netlify/functions/ops-metrics
# Same URLs with -u ops:password should return 200.
```
If any path returns 200 without creds, the protection is incomplete.

**4. Document the recovery path.** Since there is no "forgot password," store the password in a password manager **today**, not later. If lost, recovery means editing the Netlify env var and pushing a redeploy.

**5. Consider IP allowlist as a layer.** If you check the dashboard from one or two known IPs, a Netlify Edge Function can early-reject everything else. Belt-and-suspenders for a single-operator surface.

**Warning signs:**
- Browser dev tools "Network" panel shows any asset loading without an `Authorization` header.
- A `curl` to any sub-path returns 200 without credentials.
- The Netlify deploy log shows the password value (configuration mistake).

**Phase to address:**
**Phase 5 (Netlify embed + auth)** — basic auth is a Phase 5 deliverable, and the smoke test above is a Phase 5 acceptance criterion.

---

### Pitfall 7: CORS and mixed-content between Netlify HTTPS and VPS

**What goes wrong:**
Dashboard at `https://rmtnetworks.com/ops/` tries to fetch from `http://vps-ip:3001/...` directly. Browser blocks the request as mixed content. You add a self-signed cert; browser blocks it as invalid. You add proper Let's Encrypt; the request now passes mixed content, but CORS preflight fails because the VPS Node server doesn't send `Access-Control-Allow-Origin`. You add a wildcard `*`; that works but now anyone can hit the API.

**Why it happens:**
- HTTPS pages cannot fetch HTTP resources (mixed content blocked by all modern browsers).
- Self-signed certs trigger CORS-mode-fail with no override path for fetch (the browser will not prompt the way it does for top-level navigation). ([MDN: CORS request did not succeed](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS/Errors/CORSDidNotSucceed))
- Servers must send permissive CORS headers for cross-origin requests; defaults are restrictive.
- Wildcard `*` works but defeats the auth model.

**How to avoid (recommended approach):**
**Don't fetch the VPS directly from the browser.** Proxy through Netlify Functions. This is the architecture the project already uses for the subscription tracker — repeat the pattern.

```
Browser → https://rmtnetworks.com/.netlify/functions/ops-metrics → bridge on VPS (over HTTPS or a private channel)
```

Benefits:
- No CORS — same origin from the browser's perspective.
- No mixed content — everything is HTTPS to the browser.
- The Netlify Function holds the bridge auth token; the browser never sees it.
- Basic auth from Pitfall 6 naturally covers the function path.

**VPS endpoint setup:**
- Put the bridge behind nginx/Caddy on the VPS with a real Let's Encrypt cert. Caddy is simpler — three-line Caddyfile gets auto-HTTPS.
- Bridge listens on `127.0.0.1` only; nginx/Caddy is the only thing exposed publicly.
- Bridge requires a static `X-Bridge-Token` header; Netlify Function sets it from an env var.

**If you must fetch the VPS directly** (e.g., for the iframe-embedded Kuma status page — that's a top-level navigation, not a fetch):
- Real cert, HTTPS only.
- Configure `UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN=true` (see Pitfall 10).
- Don't proxy the iframe through Netlify; it's allowed to be a third-party origin as long as it's HTTPS.

**Warning signs:**
- Browser console shows "Mixed Content" or "blocked by CORS policy" errors.
- The bridge is exposed on a port directly accessible from the public internet without HTTPS.
- Any response uses `Access-Control-Allow-Origin: *` together with `Access-Control-Allow-Credentials: true` (this combination is rejected by browsers and is also a security smell).

**Phase to address:**
**Phase 3 (n8n API bridge)** — bridge exposure decisions (localhost-only behind Caddy). **Phase 5 (Netlify embed + auth)** — Netlify Functions as the proxy layer.

---

### Pitfall 8: Disk-full death spiral

**What goes wrong:**
Three retention defaults compound on the same VPS:
1. Netdata's `dbengine` keeps months of metrics by default.
2. Uptime Kuma keeps 180 days of heartbeat history by default.
3. n8n's execution data grows unbounded if `EXECUTIONS_DATA_PRUNE` is off.

On a small VPS with 20–40 GB disk, you have weeks before disk fills. When it does: n8n fails to write executions (workflow errors), Kuma fails to write heartbeats (false "down" alerts), system logs fail to rotate, and the OOM-killer becomes more aggressive as filesystem caches get squeezed. The monitor that should warn you is itself one of the offenders.

**Why it happens:**
Each tool's defaults assume it owns the disk. Colocated, the assumptions collide.

**How to avoid:**

**Set retention caps on all three, day one:**

| Tool | Setting | Recommended value |
|------|---------|-------------------|
| Netdata | `[db] dbengine multihost disk space MB` in `netdata.conf` | `256` (256 MB cap) |
| Uptime Kuma | Settings → General → Keep monitor history | `30` days |
| n8n | `EXECUTIONS_DATA_MAX_AGE` env var | `336` (hours = 14 days) |
| n8n | `EXECUTIONS_DATA_PRUNE_MAX_COUNT` | `10000` |
| n8n | `EXECUTIONS_DATA_PRUNE` | `true` |

**Add disk-watch monitors at 80% / 90% / 95%:**
- Netdata has built-in disk-space alerts but the default thresholds (90%, 95%) only trigger when it's nearly too late.
- Add an Uptime Kuma "HTTP push" monitor that's pinged by a cron at 5-minute intervals **only if** disk is under 80%. When the cron stops pinging (disk crossed 80%), Kuma fires.
- This gives you the **leading indicator** the project requires (PROJECT.md: "approaching cutoff" thresholds at 90%, 95%, 99%).

Example cron:
```bash
*/5 * * * * [ $(df / | awk 'NR==2 {print int($5)}') -lt 80 ] && curl -fsS https://kuma.local/api/push/<token>?status=up&msg=disk_ok
```

**Run a monthly maintenance job:**
- Cron: first Sunday 03:00.
- Steps: Kuma "Shrink Database" via its API, `VACUUM FULL` on n8n's Postgres (or Kuma's SQLite), Netdata cache trim, log rotation check.
- Script lives in `/usr/local/bin/ops-maintenance.sh` and pings a Kuma "monthly-maintenance" heartbeat at the end.

**Warning signs:**
- `df -h /` shows < 30% free.
- Netdata's own disk-space chart trending upward without an obvious cause.
- SQLite files (Kuma `kuma.db`, n8n `database.sqlite` if not on Postgres) over a few hundred MB.

**Phase to address:**
**Phase 0 (VPS prep)** — apply all three retention caps before installing. **Phase 1 (Kuma baseline)** — the "disk under 80%" leading-indicator monitor. **Phase 4 (Tune & Polish)** — the monthly maintenance cron.

---

### Pitfall 9: Telegram bot setup — token leakage and lost-config recovery

**What goes wrong:**
- Bot token gets committed to git (search GitHub for `bot[0-9]+:AA` — depressing volume of hits).
- The bot was set up against your personal Telegram account; you can't share alerts with a backup contact without re-doing config.
- You accidentally block the bot from a phone-cleanup moment; alerts silently stop arriving and you don't notice for weeks.
- Bot is in a group chat; someone removes the bot or restricts permissions; alerts silently stop.

**Why it happens:**
- Convenience: token gets pasted into a config file that's later git-added.
- Telegram bots have no "are you still receiving messages?" signal back to the sender. If you block, the API responds 403 — but only when Kuma actually tries to send. Between sends, there's no indication.

**How to avoid:**

**Token hygiene:**
- Store the token in Uptime Kuma's notification config, not in a file on disk that could end up in git.
- If you must put it in a config file (env vars for the bridge or maintenance script), use `.env` and gitignore it. Add a pre-commit grep for `bot[0-9]+:AA` to be safe.
- Treat the token like a password. Rotate via BotFather if leaked (`/revoke` then `/token`).

**Chat ID strategy — recommended for a solo operator:**
- Use a **dedicated private chat with the bot** (not a group). Pros: no group permission drift, can't accidentally remove the bot, fastest notification UX.
- Note the chat ID once via the `getUpdates` endpoint or Kuma's "Auto Get" button. ([Uptime Kuma + Telegram setup guide](https://viewsby.wordpress.com/2025/07/01/how-to-integrate-your-telegram-bot-with-uptime-kuma-using-bot-token-and-chat-id/))

**Heartbeat your own bot:**
- The dead-man's-switch from Pitfall 3 (healthchecks.io) covers "Kuma is alive." Add a **second** thing: a daily test alert from Kuma.
- Create an Uptime Kuma monitor that's intentionally configured to fail once per day at 09:00 (or use a scheduled "test alert" mechanism). When you stop seeing the daily test message, you know Telegram is broken.
- This is the only reliable way to detect bot-blocked / chat-deleted / token-revoked scenarios.

**Backup recipient:**
- Out of scope per PROJECT.md (Telegram only, no second recipient). Respect that. The daily test-alert habit substitutes for redundancy.

**Warning signs:**
- The token appears in `git log -p` output anywhere.
- You haven't received the daily test alert.
- BotFather shows recent suspicious activity on the bot.

**Phase to address:**
**Phase 1 (Kuma + Telegram baseline)** — token hygiene and the daily test alert. **Phase 4 (Tune & Polish)** — re-verify the daily test alert is still arriving.

---

### Pitfall 10: Embedded Kuma status page — iframe blocked by X-Frame-Options

**What goes wrong:**
You embed `<iframe src="https://kuma.rmtnetworks.com/status/default">` on `https://rmtnetworks.com/ops/`. The browser blocks the iframe with "Refused to display in a frame because it set 'X-Frame-Options' to 'sameorigin'." The dashboard renders without the status panel.

**Why it happens:**
Uptime Kuma defaults to `X-Frame-Options: SAMEORIGIN` to protect itself from clickjacking. The dashboard is on a different origin (rmtnetworks.com) from the Kuma instance (kuma.rmtnetworks.com or a subdomain). ([Uptime Kuma X-Frame-Options issue #5621](https://github.com/louislam/uptime-kuma/issues/5621)) ([cloudpap: Uptime Kuma embed guide](https://cloudpap.com/blog/uptime-kuma-embed/))

**How to avoid:**

**Set the env var when running Kuma:**
```yaml
# docker-compose.yml fragment
environment:
  - UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN=true
```
Or in systemd unit:
```
Environment="UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN=true"
```

This removes the `SAMEORIGIN` restriction. Trade-off: Kuma can now be framed by anyone on the internet — they could craft a clickjacking page. Mitigation:
- Use Kuma's "Status Page Only" mode if you only need the public status page (Settings → check the appropriate setting; this hides the admin login from non-authenticated visitors).
- Or front Kuma with nginx/Caddy and set `Content-Security-Policy: frame-ancestors https://rmtnetworks.com` — this is **stricter** than `X-Frame-Options` and allows precisely one origin. CSP `frame-ancestors` overrides `X-Frame-Options` in browsers that support both, so you can keep the env var enabled and let the reverse proxy enforce the actual policy.

**Recommended reverse-proxy CSP config (Caddy):**
```caddyfile
kuma.rmtnetworks.com {
    reverse_proxy localhost:3001
    header Content-Security-Policy "frame-ancestors https://rmtnetworks.com"
    header -X-Frame-Options
}
```

**Other embedded-iframe gotchas to plan for:**
- **HTTPS required.** Both pages must be HTTPS (no mixed content).
- **Cookies for Kuma admin auth don't flow into the iframe** by default in cross-origin contexts (SameSite=Lax). This is fine for the status page (no auth needed), but if you ever try to embed an authenticated Kuma view it won't work.
- **The status page URL needs to be a "public" Kuma status page** (Settings → Status Pages → create one and assign monitors), not the admin dashboard URL.
- **Iframe height** — Kuma's status page is a single-page app; if you don't set an explicit iframe height, you'll get scroll-within-scroll. Pick a tall fixed height (e.g., 1200px) or use a `ResizeObserver` postMessage pattern (overkill at this scale; fixed height is fine).

**Warning signs:**
- Browser console: "Refused to display 'X' in a frame because it set 'X-Frame-Options' to 'sameorigin'."
- The iframe is blank but the rest of the dashboard renders.
- Kuma's admin UI loads in the iframe (this means you embedded the wrong URL — the admin dashboard, not the public status page).

**Phase to address:**
**Phase 1 (Kuma baseline)** — set `UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN=true` and reverse-proxy CSP from the first install, not after the embed breaks. **Phase 5 (Netlify embed + auth)** — verify the iframe loads and use the status-page-only URL.

---

## Technical Debt Patterns

| Shortcut | Immediate benefit | Long-term cost | When acceptable |
|----------|-------------------|----------------|-----------------|
| Single Kuma notification provider for everything | Fastest setup; one Telegram chat | Alert fatigue; loud and silent mixed together | First 48 hours only — split into page-worthy and FYI by end of week 1 |
| Polling n8n API on every dashboard load | No caching code needed | Bridge becomes a DoS vector against n8n; slow first paint | Never — 30-second cache is 5 lines of code |
| Inline secrets in `netlify.toml` | "It works locally" | Repo compromise = full ops access | Never; use `${VAR}` substitution from Netlify env from day one |
| Self-signed cert on the VPS bridge | Skip Let's Encrypt setup | Browser fetch will not work; debugging path is opaque | Never for browser-facing; OK for cron-only callers with a token |
| `Access-Control-Allow-Origin: *` on the bridge | "Solves" CORS instantly | Anyone on the internet can call the bridge | Never — proxy via Netlify Functions instead |
| Heartbeat at the end of the workflow (no validation IF) | One fewer node | "Green" hides silent corruption | Never for any workflow whose output is consumed downstream |
| No external dead-man's-switch | Skip one signup | VPS death = silent outage | Never; healthchecks.io free tier is a 5-minute install |
| Default 180-day Kuma retention | One less setting | Disk pressure at month ~3, SQLite slowdown | Until you have a disk-watch monitor; then drop to 30 days |
| Polling Kuma's status page rather than embedding | Avoids X-Frame-Options work | Doubles the maintenance surface; loses Kuma's native UI | Never — fix the iframe headers once |
| Storing the Telegram bot token in a tracked config file | One less env var | Public token leak; bot hijack | Never |

---

## Integration Gotchas

| Integration | Common mistake | Correct approach |
|-------------|----------------|------------------|
| Uptime Kuma → Telegram | Using the same notification provider for everything; not testing | Two providers (page-worthy, FYI-silent); send a test on save; verify with the daily test-alert monitor |
| Uptime Kuma → n8n (heartbeat) | Ping at end-of-workflow unconditionally | IF-validate-then-ping pattern with `?status=up` / `?status=down` branches |
| Bridge → n8n API | No filters, fetch all executions, parse full payload | `?limit=20&includeData=false`, narrow fields, in-memory cache, adapter pattern for version drift |
| Netdata → operator (alarms) | Disable to silence noise | Tune thresholds in `health.d/*.conf`; route via Netdata's own notification or pipe to Kuma push |
| Netlify Functions → bridge on VPS | Direct fetch with no auth header | Static `X-Bridge-Token` from Netlify env var; bridge enforces on every request |
| Browser → Kuma status page | Embed the admin dashboard URL | Embed the public `/status/<slug>` URL; configure `UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN=true` + CSP `frame-ancestors` |
| Browser → bridge | Direct cross-origin fetch with CORS wildcards | Proxy via Netlify Functions; same-origin from browser's view |
| VPS cron → Kuma push monitor | Curl without `--fail` / `--retry` | `curl -fsS --retry 3 --max-time 10 <url>` — silent on success, exit non-zero on failure |
| healthchecks.io → VPS | Curl in cron without verifying Kuma is alive | Script that checks Kuma's local health endpoint and only pings on success |

---

## Performance Traps

| Trap | Symptoms | Prevention | When it breaks |
|------|----------|------------|----------------|
| Netdata 1-second sample rate | Steady ~5% CPU even at idle | `update every = 5` in netdata.conf | Always present on small VPS; problematic when CPU is contended |
| Kuma SQLite never shrunk | Slow dashboard, growing `kuma.db` | Monthly VACUUM via Settings → Backup → Shrink | After ~3 months of default retention |
| Bridge polls n8n on every dashboard request | Slow first paint, n8n CPU spikes | 30-second in-memory cache, one in-flight request | Anytime two browser tabs open the dashboard |
| Full n8n executions list with `includeData=true` | Multi-MB JSON, bridge OOM on small VPS | Always set `includeData=false`, narrow `fields` and `limit` | When workflows produce binary/large outputs (PDF gen, image processing) |
| No execution pruning in n8n | Postgres GBs after weeks, slow editor | `EXECUTIONS_DATA_PRUNE=true`, `EXECUTIONS_DATA_MAX_AGE=336` | 2–6 weeks for moderately busy instance |
| Many low-interval HTTP monitors in Kuma | Bandwidth, CPU, DB writes | Default to 60s interval; reserve 20s for genuinely critical only | After ~20 monitors at 20s intervals |
| Iframe re-loading on every page nav | Slow status panel; flicker | Make `/ops/` a single page that re-uses the iframe; avoid SPA route changes that unmount it | Always when SPA framework involved |
| Dashboard fetch with no timeout | Hangs forever if bridge slow | `AbortController` with 5-second timeout on fetch; show stale-cache fallback | Anytime VPS is under load |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Telegram bot token in git | Anyone with the token can spoof alerts, spam, or pivot to bot abuse | `.env` + gitignore; pre-commit grep for `bot[0-9]+:AA`; rotate via BotFather if leaked |
| n8n API key in bridge repo | Full read/write access to all workflows and credentials | Bridge env file gitignored; rotate via n8n Settings → API |
| Kuma admin reachable on public internet without 2FA | Account takeover → reconfigure to silence alerts | Put Kuma behind Caddy basic auth (separate from Netlify auth) + enable Kuma's own 2FA in Settings |
| `Access-Control-Allow-Origin: *` on the bridge | Any website can read your ops data from a visitor's browser | Proxy via Netlify Functions; never wildcard on the bridge |
| Netlify basic-auth password in `netlify.toml` literal | Repo read = ops access | `${OPS_PASSWORD}` env var substitution; verify with `git log -S "Basic-Auth"` |
| Netlify protection covers HTML only, not functions | Public ops API | Add a second `[[headers]]` block for `/.netlify/functions/ops-*` |
| Bridge binds `0.0.0.0` and is exposed | Anyone scanning the VPS port range can hit it | Bind `127.0.0.1`, front with Caddy with cert + bridge token |
| n8n webhooks publicly callable | Trigger workflows on demand by unknown parties | If webhooks are out of scope, disable them; otherwise add `N8N_WEBHOOK_AUTH` or path-based secret |
| Kuma's own status-page exposes internal URLs/IPs | Reconnaissance leak | Use friendly monitor names; don't put internal hostnames or IPs in monitor name/description |
| Logging Telegram messages including the token in URL | Token in log files, log shippers, screenshots | Log only the bot ID; never the full URL of the send request |

---

## UX Pitfalls (for the operator-as-user)

| Pitfall | Operator impact | Better approach |
|---------|----------------|-----------------|
| Telegram message with no severity prefix | Skim-blindness; serious alerts read same as info | Prefix with `[PAGE]` for actionable, `[fyi]` for silent; Kuma supports custom message templates per notification provider |
| Alert message says "Monitor X is DOWN" with no clue what X is | Need to log into Kuma to identify | Use monitor names that include the system AND the failure mode, e.g., `prod-supabase-rest-200` |
| Dashboard requires a login each visit | Friction; you start skipping the daily check-in | Browser-cached basic auth survives long sessions; use a sufficiently long random password |
| Dashboard shows raw metrics, no traffic-light summary | Need to interpret every visit | The bridge's host-metrics endpoint should return `{status: "green"|"yellow"|"red", details: {...}}` so the dashboard renders the light immediately |
| "Recent runs" panel orders by ID, not by timestamp | Confusing when workflows run out of order | Sort by `stoppedAt` descending in the bridge before serving |
| No way to silence a known issue temporarily | Have to disable the monitor and forget to re-enable | Use Kuma's Maintenance Windows for planned outages; for unplanned, accept the noise rather than disabling |
| Dashboard refreshes too aggressively | Battery drain on phone; layout shift | 60-second refresh max; visible "last updated" timestamp |
| No "everything is fine" indicator | Hard to tell at a glance | Single big green "ALL OK" / "ISSUES" header derived from the most-severe child status |

---

## "Looks Done But Isn't" Checklist

Verify each item before declaring the milestone complete.

- [ ] **Uptime Kuma installed:** verify it survives a VPS reboot — `systemctl is-enabled` or container `restart: unless-stopped`; do a `reboot` and confirm.
- [ ] **Telegram alerting:** send a real test alert from the running Kuma UI ("Test" button on the notification provider) — don't trust the install logs.
- [ ] **External dead-man's-switch:** intentionally stop the cron for 10 minutes and confirm healthchecks.io fires.
- [ ] **n8n heartbeat:** stop a monitored workflow, wait for the configured interval + retries, confirm Kuma marks it down AND Telegram fires.
- [ ] **Wrong-output detection:** make a workflow produce an unexpected output (empty result) and confirm the shadow-check monitor catches it.
- [ ] **Bridge:** kill the bridge process; confirm the dashboard shows a graceful "degraded" state, not a 500.
- [ ] **n8n executions pruning:** check `SELECT count(*) FROM execution_entity WHERE "startedAt" < NOW() - INTERVAL '15 days'` is 0 (or near-zero after a prune cycle).
- [ ] **Disk retention caps:** `du -sh` on Kuma's `data` dir, Netdata's cache dir, and n8n's DB — all under expected thresholds.
- [ ] **Netlify basic auth:** `curl -I` against the dashboard root, an asset path, and a function path — all return 401 without creds.
- [ ] **Iframe embed:** open the dashboard in an incognito window (no cached auth state), authenticate, and confirm the Kuma status iframe loads.
- [ ] **CORS:** no console errors in the browser dev tools on the live dashboard.
- [ ] **Mixed content:** Lighthouse / browser shows no mixed-content warnings.
- [ ] **Telegram bot reachable:** the daily test-alert monitor has fired in the last 24 hours.
- [ ] **VPS resource headroom:** `free -m` shows ≥ 300 MB available; `df -h` shows ≥ 30% free on `/`.
- [ ] **Backup of Kuma DB:** at least one tested restore of `kuma.db` to a scratch location.
- [ ] **Token hygiene:** `git log -p -- '*.toml' '*.env' '.env*'` shows no bot tokens or API keys.

---

## Recovery Strategies

| Pitfall | Recovery cost | Recovery steps |
|---------|---------------|----------------|
| Alert fatigue → muted Telegram | LOW | Re-audit each monitor's last 7 days; demote anything that fired with no action taken; re-enable notifications when noise count is < 3/week |
| Heartbeat lies (workflow green, output bad) | MEDIUM | Add validation IF + shadow-check monitor; backfill: replay the workflow over the affected period; document the missing assertion |
| VPS died, no alert fired | MEDIUM | Set up healthchecks.io immediately (this should never recur); post-mortem the missed window |
| Resource contention OOM-killed n8n | MEDIUM | Apply the Netdata trims; cap Kuma retention; restart n8n; if memory still tight, the VPS may be undersized for the workload |
| n8n executions table huge, queries slow | HIGH | `DELETE FROM execution_entity WHERE "startedAt" < NOW() - INTERVAL '14 days'`; `VACUUM FULL execution_entity`; enable `EXECUTIONS_DATA_PRUNE` so it doesn't recur |
| Bridge broken after n8n upgrade | LOW | Roll back n8n to last known good version; update bridge adapter to handle new shape; re-deploy; pin n8n version moving forward |
| Netlify basic auth leaked password | LOW | Rotate Netlify env var; trigger redeploy; browser caches will re-prompt on next request |
| Telegram bot blocked / token revoked | LOW | Create a new bot via BotFather; update Kuma's notification provider with new token; test |
| Disk filled | HIGH | `df -h` to find culprit; truncate Kuma DB (after backup) via Settings → Backup → Shrink; prune n8n executions manually; rotate Netdata cache; raise the retention caps so it doesn't recur |
| iframe shows "refused to display" | LOW | Set `UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN=true`; restart Kuma; if you want stricter than that, add Caddy `Content-Security-Policy: frame-ancestors` |

---

## Pitfall-to-Phase Mapping

Assumes a roadmap structure of: Phase 0 (VPS prep), Phase 1 (Kuma + Telegram baseline + dead-man's-switch), Phase 2 (n8n heartbeats), Phase 3 (n8n API bridge), Phase 4 (Tune & Polish + two-week audit), Phase 5 (Netlify embed + basic auth). The roadmap researcher may restructure; this mapping should be adapted accordingly.

| Pitfall | Prevention phase | Verification |
|---------|------------------|--------------|
| 1. Alert fatigue | Phase 1 (define policy) + Phase 4 (two-week audit) | Zero non-actionable alerts in last 72 hours at end of Phase 4 |
| 2. Heartbeat lies | Phase 2 (every heartbeat uses validation IF) + Phase 3 (one shadow-check monitor) | Manually break a workflow's output; confirm shadow-check fires |
| 3. Watching the watcher | Phase 1 (healthchecks.io setup, same phase as Kuma) | Stop the cron, confirm healthchecks.io alerts within 6 minutes |
| 4. Resource contention | Phase 0 (apply Netdata/Kuma/n8n config trims before install) + Phase 4 (re-measure) | `free -m` shows ≥ 300 MB free under typical load |
| 5. n8n API tarpits | Phase 0 (`EXECUTIONS_DATA_PRUNE` on) + Phase 3 (narrow filters + cache + adapter) | Bridge `/recent-runs` returns in < 200ms; load-test the dashboard with 5 concurrent tabs |
| 6. Netlify basic auth holes | Phase 5 | `curl -I` smoke test passes for HTML, assets, functions — all 401 without creds |
| 7. CORS / mixed content | Phase 3 (bridge behind Caddy + token) + Phase 5 (Netlify Functions as proxy) | No console errors on live dashboard; Lighthouse "no mixed content" |
| 8. Disk-full death spiral | Phase 0 (retention caps) + Phase 1 (disk-watch monitor) + Phase 4 (monthly maintenance cron) | Trigger an artificial disk-fill in a scratch dir; confirm 80% leading-indicator fires |
| 9. Telegram bot setup hazards | Phase 1 (token hygiene + daily test alert) + Phase 4 (verify daily test still arriving) | `git log -p` shows no token; daily test alert visible in chat history |
| 10. Iframe X-Frame-Options | Phase 1 (env var set at Kuma install time) + Phase 5 (verify embed works) | Dashboard iframe renders in incognito after auth |

---

## Sources

- [Uptime Kuma: Data Management and Backup (DeepWiki)](https://deepwiki.com/louislam/uptime-kuma/11-data-management-and-backup) — retention defaults, VACUUM/Shrink behavior
- [Uptime Kuma issue #2445: Grace period in heartbeat (push)](https://github.com/louislam/uptime-kuma/issues/2445) — retries as the grace-period mechanism
- [Uptime Kuma issue #5621: X-Frame-Options config](https://github.com/louislam/uptime-kuma/issues/5621) — `UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN`
- [Uptime Kuma issue #1146: iFrame integration not working for status page](https://github.com/louislam/uptime-kuma/issues/1146) — embed troubleshooting
- [cloudpap: Uptime Kuma embed guide](https://cloudpap.com/blog/uptime-kuma-embed/) — iframe + CSP patterns
- [Uptime Kuma + Telegram setup guide (viewsby.wordpress.com, 2025-07)](https://viewsby.wordpress.com/2025/07/01/how-to-integrate-your-telegram-bot-with-uptime-kuma-using-bot-token-and-chat-id/) — bot/chat-ID setup
- [Uptime Kuma: Configure Push Monitor (Programster's Blog)](https://blog.programster.org/uptime-kuma-configure-push-monitor) — push URL state parameters
- [Netdata community: Reduce memory footprint of Netdata Agent](https://community.netdata.cloud/t/reduce-memory-footprint-of-netdata-agent/5026) — config trims
- [Netdata: Resource utilization docs](https://learn.netdata.cloud/docs/netdata-agent/resource-utilization) — memory/CPU sizing
- [n8n: Execution data docs](https://docs.n8n.io/hosting/scaling/execution-data/) — `EXECUTIONS_DATA_PRUNE` and related env vars
- [LumaDock: Pruning old executions in n8n without losing audit value](https://lumadock.com/tutorials/n8n-prune-executions) — concrete retention recipes
- [Refactix: n8n API pagination & rate limits](https://refactix.com/ai-automation-productivity/n8n-api-pagination-rate-limits-retries) — cursor pagination, narrow filters
- [n8n: API reference](https://docs.n8n.io/api/api-reference/) — endpoint shapes and params
- [n8n: v2.0 breaking changes](https://docs.n8n.io/2-0-breaking-changes/) — version drift considerations
- [n8n issue #19358: v1.111.0 breaks API credentials](https://github.com/n8n-io/n8n/issues/19358) — example of API breakage on point release
- [Netlify: Password Protection overview](https://docs.netlify.com/manage/security/secure-access-to-sites/password-protection/) — basic auth scope
- [Netlify forum: Post to function behind basic password protection](https://answers.netlify.com/t/post-to-netlify-function-behind-basic-password-protection/95948) — functions are a separate path
- [MDN: CORS request did not succeed](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS/Errors/CORSDidNotSucceed) — self-signed cert and mixed-content interactions
- [Healthchecks.io: self-hosted vs SaaS](https://healthchecks.io/docs/self_hosted/) — pull-based dead-man's-switch model
- [Healthchecks.io vs Cronitor comparison](https://healthchecks.io/docs/healthchecks_cronitor_comparison/) — for solo-operator scale decision

---
*Pitfalls research for: solo-operator self-hosted monitoring console (RMT Networks Ops Console)*
*Researched: 2026-05-16*
