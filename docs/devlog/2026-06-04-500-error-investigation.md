# 2026-06-04 Devlog

## 09:42 EST - Production 500 Error Investigation

### Summary
User reported a 500 error while using the app (correction UI) within the past hour. SSH'd into the production droplet (`root@134.199.211.199`) and swept PM2 status, PM2 stdout/stderr logs, nginx access/error logs, Postgres logs, `dmesg`, `journalctl`, and memory state. **No origin-side error was found** — the Node process never crashed, never restarted in the window, and returned no 5xx. The most likely explanation is a Cloudflare-generated error caused by transient origin unreachability under memory/swap pressure. The standout finding is that madonnahist's Node process holds **409 MB RSS on a 1 GB droplet**, which warrants follow-up.

### What Was Found

**Process is healthy — no crash, no recent restart**
- `madonnahist` (PM2 id 3) up continuously since the 2026-06-03 16:27 UTC deploy (~21h). Both of its 2 lifetime restarts were at that deploy; `unstable_restarts: 0`. No restart in the last hour.
- Host `uptime`: 98 days, load average `0.03` — no CPU stress.
- No runtime OOM-kill. The only `dmesg` OOM events are from **Apr 27–28** and were `npm ci` *deploy* processes being killed during build, not the running app.

**No 5xx reached the origin**
- Dedicated `madonnahist.access.log` (current + all rotated/gzipped back to May 11): **zero 5xx**, every request `200`. Today's traffic: a correction session 12:08–12:23 UTC (all `POST .../save` returned 200), then one `GET /correct` → 200 at 13:34. Access-log gap from 12:23 → 13:34.
- `madonnahist.error.log` (nginx): empty (0 bytes since May 11).
- App stderr (`/var/log/pm2/madonnahist.err.log`) logs every non-2xx; today it has **nothing** — no unhandled exceptions. Last entries are favicon 404s from yesterday.

**Postgres clean in the window**
- No errors 12:00–13:40 UTC; just a normal checkpoint at 12:25 (correlates with the 12:23 save). The permission-denied errors at 00:23–00:32 UTC are unrelated leftovers from an overnight manual migration run as the wrong role (`madonnahist_owner` attempting CREATE DATABASE / ALTER on tables it doesn't own).

**Memory pressure (the real concern)**
```
Mem:  961 total / 865 used / 77 free / 95 available    Swap: 216 used (807 free)
madonnahist node RSS: 409 MB = 41.6% of RAM
giftlist:     87 MB
gaylonphotos: 80 MB
```
- 1 GB droplet shared by three Node apps + Postgres + nginx, running with only **~95 MB available and swap actively engaged**.
- madonnahist's process is **~5× the footprint of its two sibling apps** despite a similar SvelteKit/adapter-node stack — an anomaly. The heavy routes exercised today were image endpoints (`cell-image`, `page-image`, and a 1.4 MB `grid-align/page-image`), which run Sharp.

### Theory
Because nothing errored at nginx, the app, or Postgres, the 500 the user saw almost certainly **originated at Cloudflare's edge, not the origin** — a transient origin timeout/unreachable blip (Cloudflare 502/520/522/524, which a user would reasonably round to "500"). Under the observed memory pressure, a heavy Sharp/image request causing a brief swap-thrash stall is the likeliest trigger: the Node process stalls long enough that Cloudflare's connection to the origin times out and CF serves its own error page. Cloudflare-generated 5xx never reach nginx, which is consistent with the absence of any origin log line and the access-log gap at 12:23–13:34.

### Follow-Up Needed
1. **Confirm error source in the Cloudflare dashboard** — Analytics → Security/Errors, or origin error events for `madonnahist.gaylon.photos` around the timeframe. That is the only place a CF-generated 5xx would be recorded.
2. **Investigate madonnahist's outsized memory footprint (409 MB RSS).** It is disproportionate vs. siblings (~80 MB). Suspect a **Sharp buffer leak** — watch whether RSS grows after image-heavy requests (`cell-image`, `page-image`, `grid-align`, OCR cropping) and is not released. Consider a `max_memory_restart` guardrail in the PM2 ecosystem config given how tight the box is.
3. **A DigitalOcean plan upgrade for more memory may be needed.** The droplet runs three Node apps + Postgres on 1 GB with swap already in use; headroom is minimal and deploy-time `npm ci` has previously been OOM-killed (Apr 27–28). More RAM would relieve both the swap-thrash stalls and the deploy fragility, independent of fixing the per-process leak.

### Files Modified
- None. Investigation only; no code changed.
