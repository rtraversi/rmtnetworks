# Feature Research

**Domain:** Solo-operator self-hosted monitoring console (Uptime Kuma + Netdata + n8n bridge + embedded dashboard)
**Researched:** 2026-05-16
**Confidence:** HIGH (Uptime Kuma + n8n behavior verified against current docs; thresholds anchored to industry-standard defaults; explicit anti-features cross-checked against PROJECT.md Out-of-Scope)

> Scope reminder from PROJECT.md: one VPS hosts Uptime Kuma + Netdata + n8n + the bridge; the dashboard at rmtnetworks.com embeds Kuma's status page and composes two bridge widgets (host traffic light, n8n recent runs); Telegram is the only alert channel; the operator is one person who does a daily check-in plus intraday glances.

---

## Feature Landscape

### Table Stakes (Without These The System Fails Its Core Value)

Each row is tied to an Active requirement in PROJECT.md and to the operator's actual two-mode usage: (a) Telegram pages me when something breaks, (b) one glance at the dashboard tells me nothing is broken.

#### Uptime Kuma — Monitor Coverage

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **HTTP(S) monitor on Supabase health endpoint** | The data plane behind the only product surface; if Supabase is down the tracker is down. Directly maps to PROJECT.md Active item "monitor Supabase health endpoint". | LOW | Use Kuma's built-in HTTP monitor. 60s interval is the default and is correct for this scale — sub-minute is alert-fatigue territory for a solo operator. Configure 2 retries before "down" (so a single transient blip doesn't page). |
| **HTTP(S) keyword monitor on at least one critical workflow output URL** | An HTTP 200 from n8n's webhook doesn't prove the workflow ran end-to-end. A keyword check on a downstream artifact (e.g., a JSON field, a Supabase row count endpoint) confirms the chain actually worked. PROJECT.md: "HTTP-based liveness signal per critical workflow path." | LOW–MED | Kuma keyword monitor: provide expected substring; flips DOWN if substring missing. Pair with a Netlify function that returns a short JSON the keyword can match against. |
| **Push (heartbeat) monitor per critical n8n workflow** | This is the only bulletproof way to detect "scheduled and didn't run" — pull-based monitoring can't see the absence of an execution. PROJECT.md: "heartbeat URLs pinged on success from each critical workflow's success path." | LOW | Each Kuma push monitor has its own URL; the n8n workflow's last node is an HTTP Request to that URL on success. Set "Heartbeat Interval" = expected cadence, "Heartbeat Retry Interval" = ~50% of the cadence. A missed window pages immediately — this is what catches scheduler death, queue-stuck executions, and disabled workflows. |
| **TCP/port monitor on the VPS for n8n's port (and any other process the bridge depends on)** | An HTTP healthcheck can return 200 from a stale process; a TCP probe confirms the listener is alive. Cheap insurance for the bridge itself and for n8n. | LOW | Kuma TCP monitor; 60s interval. |
| **SSL certificate expiry monitor on rmtnetworks.com and any TLS endpoint the bridge calls** | A cert expiring silently is a top-three "embarrassing outage" cause and Kuma supports it natively. Warning at 14 days is the standard early-warning band. | LOW | Kuma's HTTP monitor has built-in cert expiry warning days; set to 14 (warning) — 7 days is too late for a solo operator who may be offline a weekend. Sources: Uptime Kuma docs, [Better Stack guide](https://betterstack.com/community/guides/monitoring/uptime-kuma-guide/), [DoHost SSL/DNS/DB guide](https://dohost.us/index.php/2026/04/25/monitoring-beyond-http-tracking-ssl-dns-and-databases-in-kuma/). |

**Note on monitor types deliberately NOT in table stakes:**
- **DNS monitor**: Useful only if you self-manage DNS or have had DNS incidents. Not relevant for a Netlify-fronted site with Cloudflare/Netlify DNS. Move to differentiator if a DNS-flake incident ever occurs.
- **Ping (ICMP) monitor**: ICMP up tells you almost nothing useful when you already have HTTP and TCP probes on the same box. Adds noise without information.

#### Uptime Kuma — Alert Routing

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Telegram notification channel attached to every monitor** | Telegram is the pager (PROJECT.md constraint). One bot, one chat. | LOW | Kuma has native Telegram integration; no relay service needed. |
| **"Down after N retries" not "down on first failure"** | Default of 0 retries causes a single timeout to page you. 2 retries at 60s interval = ~3 minutes of failure before Telegram fires, which is the right floor for a non-customer-facing service. | LOW | Set on each monitor. |
| **Per-monitor notification cooldown / "important" tag** | Kuma fires once on state change (down→up→down), which is correct behavior; what you do NOT want is per-check pinging. | LOW | This is Kuma's default; do not change it. |

#### Netdata — Host Metrics + Traffic-Light Derivation

These are the metrics that actually drive operator decisions on a single VPS. Everything else is noise unless you're debugging a specific incident.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Disk usage % per mounted filesystem (`/`, plus any data volume)** | Disk filling kills Postgres, kills logs, kills Docker. This is the #1 cause of "VPS quietly broke at 3am" stories. | LOW | Netdata reports this natively; alarm thresholds discussed below. |
| **RAM "available" (not "used")** | "RAM used" on Linux is a lie because of page cache; what matters is `MemAvailable`. Operators who panic over "95% RAM used" on a healthy box have been bitten by this. | LOW | Netdata exposes both; the traffic light should use available (or `1 - available/total`). |
| **Swap activity (rate of swap-in pages/sec), not swap-used %** | Steady swap *use* on a low-RAM VPS is normal; swap *thrashing* (high si/so pages-per-second) means RAM exhaustion is actively hurting. This is the metric that distinguishes "fine" from "the box is dying right now." | LOW | Netdata `mem.swapio`. |
| **Load average (1-min and 5-min) relative to vCPU count** | Load > vCPU count sustained = CPU starvation. The ratio matters, not the absolute number — load 4.0 on a 4-vCPU box is fine; load 4.0 on a 1-vCPU box is on fire. | LOW | Netdata `system.load`. Source confirms 5-min load >= vCPU count is the standard threshold. |
| **CPU iowait %** | High iowait means disk is the bottleneck — usually because of swap, runaway logs, or a slow workflow. Without iowait, "high CPU" alarms are ambiguous. | LOW | Netdata `system.cpu` `iowait` dimension. |
| **Network throughput (sanity check, not for alerting)** | Useful as a "is anything happening" signal during incident triage; not an alert target. | LOW | View-only on Netdata's dashboard. |

**Traffic-light derivation rule the bridge should encode** (anchored to standard 80/90/95 banding from Netdata defaults and industry practice):

- **GREEN** — all of: disk < 80% on every mount, MemAvailable > 20% of total, load5 < (vCPU × 0.80), iowait < 10%, no sustained swap thrash.
- **YELLOW** — any of: disk ≥ 80% on any mount, MemAvailable 10–20% of total, load5 between (vCPU × 0.80) and vCPU, iowait 10–25%, occasional swap activity.
- **RED** — any of: disk ≥ 90% on any mount, MemAvailable < 10% of total, load5 ≥ vCPU, iowait ≥ 25% sustained, swap thrashing.

The bridge returns one of `green|yellow|red` plus a short reason string (`"disk: /var at 91%"`). The dashboard renders a single colored dot + reason — anything more elaborate is over-engineering for a solo glance.

#### Disk Capacity Warning Bands (the "earliest useful warning" question)

For a solo operator who isn't watching constantly, the standard tiering is:

| Threshold | Action | Telegram? | Why |
|-----------|--------|-----------|-----|
| **80%** | Informational (yellow in dashboard, no page) | No | Plenty of time. Pages at this level cause fatigue. |
| **90%** | Warning page | YES | This is the "do something this week" line. For a solo operator who may be away for a weekend, **90% is the earliest useful page** — 80% is too noisy, 95% is too late. |
| **95%** | Critical page (re-fire even if 90% was already paged) | YES | "Do something today." |
| **99%** | Emergency page | YES | Postgres and Docker often fail at >99%, sometimes earlier. |

PROJECT.md already lists "disk 90%, 95%, 99%" — this matches industry standard and the 80% level is reserved for the dashboard yellow band, not for Telegram.

#### n8n "Recent Runs" Panel

The bridge pulls from `/api/v1/executions` and the dashboard renders the most recent ~15 rows. At-a-glance columns, ordered by what actually answers "is anything wrong":

| Column | Why It's On The Panel | Notes |
|--------|----------------------|-------|
| **Status icon** (success / error / running) | First scan target — colored dot lets you skim the column in <1 second. | n8n statuses: `new`, `running`, `waiting`, `success`, `error`, `cancelled`. Collapse to three: success / running (incl. waiting) / failed (incl. cancelled). |
| **Workflow name** | "Which one?" — must be the actual name, not the ID. | n8n returns workflow name in the executions list. |
| **Last run time (relative: "3m ago", "1h ago")** | Relative time is glance-friendly; absolute time is only needed when you click in. | Use ISO `startedAt`. |
| **Duration** | Regressions (a workflow that used to take 8s now takes 90s) are an early warning sign. One number, no chart. | `stoppedAt - startedAt`. Show "running 4m" for in-flight. |
| **Error message snippet (first 80 chars, truncated)** | On a failure row, you usually know what to do from the first line of the error. Snippets save a click. | n8n includes `data.resultData.error.message` on failed executions. Truncate; full message on click-through to n8n. |
| **Click-through link to n8n's own execution view** | When you actually need to debug, the panel is not the debugger — n8n is. | URL: `${N8N_BASE}/workflow/${workflowId}/executions/${executionId}`. |

**Critical distinction: "scheduled and missed" vs "ran and failed"**

This is the question the panel CANNOT answer on its own, because absence-of-record looks like nothing on a recent-runs list. The operator has to know about a missed run from a *different* signal:

- **"ran and failed"** → an execution row exists with status `error` → visible in the recent-runs panel AND fires a Kuma push monitor alert because the success heartbeat never pinged.
- **"scheduled and missed" (workflow disabled, scheduler dead, queue stuck)** → no execution row → invisible to the recent-runs panel → ONLY caught by the Kuma push monitor's "heartbeat overdue" alarm.

This is why heartbeats are non-negotiable and not redundant with the API pull: each catches a failure mode the other can't see. Reference: [flowgenius.in n8n stuck executions guide](https://flowgenius.in/n8n-stuck-executions-detection/).

#### Dashboard Composition

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Embedded Uptime Kuma status page (iframe or reverse-proxied)** | PROJECT.md key decision — don't rebuild Kuma's UI. | LOW | Iframe is simplest. If iframe is blocked by Kuma's CSP, reverse-proxy through a Netlify function. |
| **Host traffic-light widget (one colored dot + one-line reason)** | The whole point of derived state — one symbol answers "is the box OK?". | LOW | Polls `/bridge/host` every 30–60s. |
| **n8n recent-runs widget** | See above. | LOW–MED | Polls `/bridge/n8n/recent` every 30–60s. |
| **"Last updated" timestamp on each widget** | If the bridge dies, the widgets would otherwise show stale data forever. A "last updated 8m ago" cue says "trust this less." | LOW | Render `Date.now() - fetchedAt`. Turn it red if > 3× polling interval. |
| **Basic auth gate (Netlify built-in)** | PROJECT.md constraint. | LOW | Netlify `_headers` / site password. |

---

### Differentiators (Real Value Beyond Table Stakes)

These are worth considering only after table stakes ship. Each one has a specific trigger condition for adding it.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Bridge self-health endpoint** (`/bridge/health` returning 200 + version + uptime, monitored by Kuma) | Closes the loop: if the bridge dies, the widgets go stale silently. A Kuma HTTP monitor on the bridge itself ensures Telegram pages when the monitor-of-the-monitors breaks. | LOW | This is borderline table-stakes — strongly recommend including in v1. It costs ~10 lines of code. |
| **Supabase synthetic read query** (bridge endpoint that runs `select count(*) from a known table limit 1` and returns OK/duration) | Distinguishes "Supabase responds to /rest/v1 health" from "Supabase actually serves queries against the schema my app uses." Has caught real outages that an HTTP healthcheck missed. | MED | Use service-role key in bridge env. Add a Kuma HTTP keyword monitor pointing at this endpoint. Trigger to add: any time a "Supabase is up but my app sees errors" incident occurs. |
| **n8n execution duration trend / regression flag** | A workflow that used to take 5s and now takes 60s is failing slowly. Compare current run duration to rolling 24h median; flag if > 3× median. | MED | Compute server-side in bridge; surface a small "↑3x" badge on the recent-runs row. Trigger to add: after the first "it was running, just slowly enough to look fine" incident. |
| **Failure rate sparkline per critical workflow** (last 24h success/fail ratio) | Catches "this workflow fails 1-in-10 silently retries" patterns that single-event monitoring misses. | MED | Bridge aggregates per-workflow over a window; widget renders a tiny green/red bar. |
| **Stuck-execution detector** (n8n executions in `running` or `waiting` for > 2× expected duration) | Stuck executions are a known n8n failure mode that don't trigger either heartbeats or status-error alerts. | LOW–MED | Bridge query: `?status=running` and filter by `startedAt < now - threshold`. Source: [flowgenius.in](https://flowgenius.in/n8n-stuck-executions-detection/). |
| **Mobile-friendly dashboard layout** | The dashboard is glanced at from a phone after a Telegram ping. A layout that requires pinch-zoom defeats the point. | LOW | Single-column responsive; widgets stack. |
| **Acknowledge / silence button in dashboard** (Kuma supports maintenance windows) | When you know the VPS is being upgraded, suppressing alerts prevents Telegram fatigue. | LOW | Use Kuma's native maintenance windows; no custom code. |
| **DNS monitor on the rmtnetworks.com record** | Only valuable if you've had a DNS incident. | LOW | Move from anti to differentiator if/when triggered. |

---

### Anti-Features (Common In Monitoring Tutorials — Wrong For This Scope)

Each anti-feature is paired with the specific reason it doesn't fit a solo-operator console and the alternative already covered in table stakes.

| Feature | Why Requested (Surface Appeal) | Why Wrong For Solo Scope | Alternative |
|---------|-------------------------------|--------------------------|-------------|
| **PagerDuty / Opsgenie integration** | "Real ops teams use PagerDuty." | PagerDuty's value is escalation policies, on-call rotations, and SLA tracking. Solo operator with one phone = there is no escalation. Pure cost and config drag. | Telegram bot to a single chat (PROJECT.md constraint). |
| **On-call rotations / schedules** | Tutorials assume a team. | There is one person. Rotations are not just unnecessary — they introduce a failure mode (wrong person paged) that doesn't exist today. | N/A — do not build. |
| **SLO/SLI math (error budgets, burn rates)** | SRE blogs make this look mandatory. | SLOs are a tool for arbitrating priorities between teams shipping features and teams maintaining reliability. With one person there is no arbitration to perform. The math is overhead without a decision attached. | Simple thresholds (90/95/99 disk, etc). Decision = "fix it." |
| **Multi-recipient email alerts (CEO + ops)** | "Stakeholders should know." | PROJECT.md explicitly Out of Scope — there is no second recipient; the "CEO" framing was shorthand. Adding a second channel doubles alert-fatigue surface for zero new information. | Telegram only. |
| **Daily/weekly digest emails** | "Stay informed." | Same as above — Telegram covers urgent, dashboard covers ambient. A digest is a third channel that competes with both for attention and arrives stale. PROJECT.md Out of Scope. | Open the dashboard on the morning check-in. |
| **Public status page** | "Looks professional." | This is an internal ops console. A public page implies an SLA to customers who don't exist for this surface and creates a maintenance burden (incident updates, retrospectives) that doesn't pay off. PROJECT.md Out of Scope. | None — embed Kuma behind basic auth. |
| **Grafana / Prometheus / Loki for one viewer** | "Industry standard." | Grafana is a query-building tool for people who need ad-hoc dashboards. A solo operator with a fixed set of widgets does not need a query language; pre-baked widgets in 50 lines of JS beat a Grafana install (TLS, auth, plugin updates, dashboard JSON to maintain) at this scale. | Bridge JSON endpoints + plain HTML widgets. |
| **Long-term metrics warehouse (InfluxDB, TimescaleDB, VictoriaMetrics)** | "Trend analysis." | Netdata's rolling window covers debugging incidents; trends over months only matter if you're capacity-planning across multiple boxes. PROJECT.md Out of Scope. | Use Netdata's default retention; export only if a specific incident demands history. |
| **Anomaly detection / ML-based alerting** | "Smarter alerts." | At one box and a handful of workflows, anomaly detection's false-positive rate exceeds the human cost of writing static thresholds. ML alerting also tends to alert on things that don't have actions attached, which is alert fatigue dressed up. | Static thresholds; revisit if a specific noisy/quiet alert pattern emerges. |
| **Custom Kuma UI built on Kuma's API** | "Branded dashboard." | PROJECT.md key decision — embed, don't rebuild. Re-implementing Kuma's UI to make it match a dark theme costs days and adds no operator value. | Iframe Kuma's status page. |
| **Public-site uptime monitoring (rmtnetworks.com itself)** | "We monitor websites." | PROJECT.md Out of Scope — the marketing site failing is not the ops risk this project addresses; the data/automation tier is. Monitoring the static front-end adds noise and would page on Netlify CDN blips that don't affect the operator's actual concern. | SSL cert monitor on the domain is enough (table stake). |
| **Multi-channel alerting (Telegram + Slack + Discord + email)** | "Redundancy." | Each channel is a separate place to triage. Redundancy at the channel level just means messages get acknowledged in the most convenient place and ignored elsewhere. | One channel; trust the channel. |
| **Web-based "incident" workflow with timelines, post-mortems, follow-up tickets** | "Best practice." | Process overhead for a single person. The incident workflow is "fix it, write a note in the project log if it's interesting." | A `LEARNINGS.md` line per surprising incident; nothing more. |
| **Alerting on every Netdata default alarm out of the box** | Netdata ships ~hundreds of alarms enabled. | Most will fire and not be actionable on a small VPS (e.g., container-runtime alarms, NIC error rates on virtual NICs). Default-everything alarming is the fastest path to alert fatigue. | Whitelist only the metrics enumerated in table stakes (disk, MemAvailable, load5, iowait, swap thrash). Disable the rest. |
| **Authenticated per-user dashboard with login** | "Real apps have login." | PROJECT.md constraint — basic auth is sufficient. There is no per-user state on this page; user accounts would be ceremony with no payoff. | Netlify basic auth. |

---

## Feature Dependencies

```
[Netdata installed on VPS]
    └──required by──> [Bridge /host endpoint]
                          └──required by──> [Dashboard host traffic-light widget]

[n8n REST API enabled + API key]
    └──required by──> [Bridge /n8n/recent endpoint]
                          └──required by──> [Dashboard recent-runs widget]
                          └──required by──> [Stuck-execution detector (differentiator)]
                          └──required by──> [Duration regression flag (differentiator)]

[Uptime Kuma installed]
    └──required by──> [HTTP monitor on Supabase]
    └──required by──> [Push monitor per critical workflow]
    └──required by──> [TCP monitor on n8n port]
    └──required by──> [SSL cert monitor]
    └──required by──> [Telegram alert routing]
    └──required by──> [Embedded status page on dashboard]
    └──required by──> [Maintenance-window silence (differentiator)]

[Telegram bot configured]
    └──required by──> [Kuma Telegram alert routing]

[Bridge process running]
    └──required by──> [Bridge self-health endpoint (strongly recommended)]
        └──required by──> [Kuma HTTP monitor on bridge itself]

[n8n workflow modified to ping success URL]
    └──required by──> [Push (heartbeat) monitor signal]

[Supabase synthetic read endpoint in bridge] ──enhances──> [Supabase HTTP monitor]
    (the synthetic catches a class of failures the basic HTTP healthcheck cannot)

[Failure rate sparkline] ──conflicts──> [Long-term metrics warehouse (anti-feature)]
    (the sparkline uses rolling in-memory window; if you add a warehouse you'd be tempted to
     overbuild this into multi-day charts, which is out of scope)
```

### Dependency Notes

- **Heartbeats require workflow modification:** Each critical n8n workflow must be edited to add an HTTP Request node at the end of the success path pointing at Kuma's push URL. This is a one-time per-workflow cost.
- **Bridge self-health closes the loop:** Without it, "bridge is dead" is invisible. Adding it costs ~10 lines but transforms the system from "fragile to bridge failure" to "self-detecting." This is the strongest "differentiator that should probably be table-stake" item.
- **Synthetic read enhances Supabase HTTP monitor; doesn't replace it:** The HTTP monitor catches "Supabase API is unreachable"; the synthetic catches "API responds but auth/schema/RLS is broken for our keys."
- **n8n API key scoping:** The bridge only needs `execution:read`. Do not grant `execution:stop` or `workflow:*` — least privilege simplifies post-compromise reasoning.

---

## MVP Definition

### Launch With (v1) — The Two-Mode Loop

The minimum that delivers PROJECT.md's Core Value: "when something breaks, Telegram pings; when nothing's broken, one page confirms."

- [ ] **Uptime Kuma on VPS** with the five table-stake monitors: Supabase HTTPS, n8n TCP, one workflow HTTPS+keyword, one push heartbeat per critical workflow, SSL cert on the dashboard domain
- [ ] **Kuma Telegram notification** wired to all monitors (2 retries → page)
- [ ] **Netdata on VPS** with default UI exposed locally (not internet-facing); alarms whitelisted to the five metrics that matter (disk, MemAvailable, load5, iowait, swap thrash)
- [ ] **Kuma push monitor on Netdata's alert webhook** for disk 90/95/99% and the other whitelisted thresholds — translates Netdata alarms into Telegram via Kuma (single alert path)
- [ ] **Bridge** with three endpoints: `/host` (traffic light + reason), `/n8n/recent` (last 15 executions), `/health` (200 OK + version)
- [ ] **Kuma HTTP monitor on the bridge's `/health`** so a dead bridge pages
- [ ] **Dashboard page on rmtnetworks.com** with: embedded Kuma status page, host traffic-light widget, n8n recent-runs widget, last-updated stamps, behind Netlify basic auth
- [ ] **At least one n8n workflow** modified to ping Kuma's push URL on success (validates the heartbeat pattern end-to-end before rolling out to more)

### Add After Validation (v1.x)

Triggers indicate when to add.

- [ ] **Supabase synthetic read endpoint** — trigger: first "Supabase is up but my app sees errors" incident
- [ ] **Stuck-execution detector** — trigger: first stuck-execution incident, OR proactively if any long-running workflow exists
- [ ] **Duration regression flag** — trigger: first "it was running, just slowly" incident
- [ ] **Failure-rate sparkline** — trigger: any workflow that retries and partially succeeds in a pattern that single-event status hides
- [ ] **Maintenance-window silence** — trigger: first planned VPS reboot/upgrade that floods Telegram

### Future Consideration (v2+) — Almost All Out Of Scope

- [ ] **Anything multi-host** — only if a second VPS is provisioned (PROJECT.md scope: one VPS)
- [ ] **DNS monitor** — only if a DNS incident occurs
- [ ] **Public status page** — only if external stakeholders ever need it (PROJECT.md Out of Scope)
- [ ] **Time-series warehousing** — only if capacity-planning across machines becomes a need (PROJECT.md Out of Scope)

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Kuma HTTPS monitor on Supabase | HIGH | LOW | P1 |
| Kuma push (heartbeat) monitor per critical workflow | HIGH | LOW | P1 |
| Kuma TCP monitor on n8n port | MEDIUM | LOW | P1 |
| Kuma keyword monitor on workflow output | HIGH | LOW | P1 |
| Kuma SSL cert monitor (14-day warning) | MEDIUM | LOW | P1 |
| Kuma Telegram routing (2-retry threshold) | HIGH | LOW | P1 |
| Netdata installed, whitelisted alarms only | HIGH | LOW | P1 |
| Disk 90/95/99% Telegram alerts | HIGH | LOW | P1 |
| Bridge `/host` traffic-light endpoint | HIGH | LOW | P1 |
| Bridge `/n8n/recent` endpoint | HIGH | LOW–MED | P1 |
| Bridge `/health` self-check + Kuma monitor on it | HIGH | LOW | P1 |
| Dashboard page (embed + 2 widgets + basic auth) | HIGH | LOW–MED | P1 |
| First workflow modified with push heartbeat | HIGH | LOW | P1 |
| Last-updated staleness indicator on widgets | MEDIUM | LOW | P1 |
| Supabase synthetic read endpoint | MEDIUM | MED | P2 |
| Stuck-execution detector | MEDIUM | LOW–MED | P2 |
| Maintenance-window silence | MEDIUM | LOW | P2 |
| Mobile-friendly layout | MEDIUM | LOW | P2 |
| Duration regression flag | MEDIUM | MED | P2 |
| Failure-rate sparkline | LOW–MED | MED | P3 |
| DNS monitor | LOW | LOW | P3 |

**Priority key:**
- P1: Must have for MVP launch — the two-mode loop doesn't work without these
- P2: Add after first weeks of operation, triggered by specific incidents
- P3: Defer indefinitely unless a triggering event happens

---

## Competitor Feature Analysis

Not a competitive product domain (internal tooling) — but adjacent solutions worth checking against:

| Feature | Self-hosted alternatives (Healthchecks.io self-host, OneUptime, Cronicle) | Cloud SaaS (BetterStack, Pingdom, StatusCake) | Our Approach |
|---------|---------------------------------------------------------------------------|-----------------------------------------------|--------------|
| Heartbeat / cron monitoring | Healthchecks.io is the gold standard for this single feature | BetterStack offers it as an add-on | Use Kuma's push monitor — already on the box, one less service to run |
| Status page | OneUptime has a built-in public status page builder | Most have public status pages | Embed Kuma's internal status page; no public version |
| Host metrics | None (these tools focus on synthetic checks) | None | Netdata for host metrics, bridge for the traffic-light summary |
| Workflow-engine integration | None native to n8n | None native to n8n | Custom bridge — we own this integration because no off-the-shelf option exists |
| Alert routing | Most support 10+ channels (PagerDuty, Slack, email, SMS) | Same | Telegram only — explicit constraint, simpler is better |

The conclusion the table supports: there is no off-the-shelf product that covers the n8n bridge piece. Everything else (uptime checks, host metrics, status pages) is well-served by existing tools — which is why the project's only custom code is the bridge.

---

## Sources

- **Uptime Kuma monitor types and behavior** (HIGH confidence): [GitHub louislam/uptime-kuma](https://github.com/louislam/uptime-kuma), [Better Stack: A Complete Guide to Monitoring With Uptime Kuma](https://betterstack.com/community/guides/monitoring/uptime-kuma-guide/), [DoHost: Monitoring Beyond HTTP — SSL, DNS, Databases in Kuma](https://dohost.us/index.php/2026/04/25/monitoring-beyond-http-tracking-ssl-dns-and-databases-in-kuma/), [OSSAlt: Self-Hosted Monitoring for Homelabs 2026](https://ossalt.com/guides/uptime-kuma-self-hosted-monitoring-homelab-2026), [Help Net Security: Uptime Kuma](https://www.helpnetsecurity.com/2026/02/20/uptime-kuma-open-source-monitoring-tool/)
- **Netdata default alarms and thresholds** (MEDIUM confidence — defaults documented, but tuned per environment): [Netdata: Configure Health Alerts](https://learn.netdata.cloud/docs/alerts-&-notifications/alert-configuration-reference), [Netdata GitHub issue on load alarms (#3003)](https://github.com/netdata/netdata/issues/3003), [Netdata community: disk space alerts](https://community.netdata.cloud/t/how-set-alert-and-threshold-for-disk-space/4274)
- **n8n executions API and status semantics** (HIGH confidence): [n8n Docs: Executions](https://docs.n8n.io/workflows/executions/), [n8n Docs: All executions](https://docs.n8n.io/workflows/executions/all-executions/), [n8n Docs: Execution data](https://docs.n8n.io/hosting/scaling/execution-data/), [flowgenius.in: detecting stuck n8n executions](https://flowgenius.in/n8n-stuck-executions-detection/)
- **VPS health monitoring (CPU/RAM/disk thresholds and load-vs-vCPU rule)** (MEDIUM confidence): [DCHost: Monitoring VPS Resource Usage](https://www.dchost.com/blog/en/monitoring-vps-resource-usage-with-htop-iotop-netdata-and-prometheus/), [ServerAvatar: CPU/RAM/Disk on Linux VPS](https://serveravatar.com/check-cpu-ram-disk-usage-linux-vps/), [VPS.DO: VPS Monitoring](https://vps.do/vps-monitoring-how-to-set-up-uptime-cpu-and-alert-notifications/)
- **PROJECT.md** (authoritative): `.planning/PROJECT.md` — Active requirements, Out of Scope, Key Decisions

---
*Feature research for: solo-operator self-hosted ops console (Uptime Kuma + Netdata + n8n bridge)*
*Researched: 2026-05-16*
