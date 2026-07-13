# KIDS FUN — Task 6: Fly.io worker deploy + real cadence-driven scheduler

**Date:** 2026-07-13 · **Branch:** `overnight/fly-worker-deploy` (from `main@8842ea8`)
**Stream:** Developer-Ops (parallel build) · **Outcome:** ✅ **DEPLOYED & LIVE** — no Jon-blocker.

---

## TL;DR

- **fly-io token: SUFFICIENT now** — the prior "cannot create app" (403) blocker is **resolved**.
  The app `kids-fun-worker-staging` already exists under org `personal`; the token has org
  visibility **and write scope** (staged the `DATABASE_URL` secret and ran a full `fly deploy`).
  **No `NEEDS JON` credential blocker.**
- Built the **real cadence-driven scheduler entrypoint** (replaces the health-only stub / the
  one-shot `ingest:once`). It runs two cooperating loops over the durable Postgres job queue.
- **Validated end-to-end three ways** against the live staging Supabase DB: (1) local node run,
  (2) local Docker container, (3) the **live Fly machine** — each fired at least one real
  ingestion cycle (enqueue → dequeue → terms-gated ingest → `source_check_run=success`).
- All repo verification green: worker `tsc` build, root typecheck, root lint, `vitest`.

---

## 1. Credential / token status

| Credential | Slug | Status |
|---|---|---|
| Fly.io | `fly-io` | ✅ **Usable.** Macaroon token; sees org `personal` (approved org per `docs/infra.md`), lists apps, **stages secrets, and deploys.** The old token was deploy-scoped-only and 403'd on *app create*; the app now already exists (`pending`) so only deploy scope was needed — and the token has it. |
| Supabase staging | `kids-fun-supabase-staging` | ✅ present; `db_url` = **direct** host (see §4). |
| GitHub (push) | `kids-fun-github-jdcinc` | present (used for the branch push at end of task). |

> **No credential scope blocker for Jon.** The one thing worth doing (minor, non-blocking):
> store a dedicated **pooler** connection string in the vault (see §4) so future container/Fly
> deploys don't reconstruct it.

## 2. What got deployed

- **Fly app:** `kids-fun-worker-staging` · org `personal` · region **`yyz`** (Toronto,
  aligns with approved `ca-central-1`).
- **Machine:** `891242a6431232` (`shared-cpu-1x`, 1024 MB), state `started`,
  health check `servicecheck-00-http-8080` **passing (1/1)**.
- **Image:** built locally (`--local-only`), pushed to `registry.fly.io/kids-fun-worker-staging`
  (354 MB). Single machine (`--ha=false`).
- **Secret:** `DATABASE_URL` set via `flyctl secrets import` over **stdin** (never in argv/logs) —
  points at the Supabase **session pooler** (§4).
- **Public URL:** `https://kids-fun-worker-staging.fly.dev/` — `/healthz` reachable, HTTP 200.

**Nothing is blocked.** (For contrast, `docs/infra.md` still lists the Fly worker as BLOCKED —
that line is now stale; left to the doc-owning stream to update, or update on merge.)

## 3. Scheduler design & cadence

The worker entrypoint (`dist/src/index.js`) now runs the health server **plus** a continuous
cadence-driven scheduler (`worker/src/scheduler.ts`), two cooperating loops sharing the durable
`job_queue`:

1. **Tick loop** — every `WORKER_SCHEDULER_TICK_MS` (default **60 s**) calls
   `enqueueDueJobs()` (`worker/scheduler/tiered.ts`), the trigger-agnostic tiered policy that
   asks *which sources are due* and enqueues an `ingest` job for each. Idempotent per tick
   (skips sources with a pending/running job) and it stamps `source.next_check_at` forward.
2. **Queue loop** — every `WORKER_POLL_INTERVAL_MS` (default **5 s**) claims one due job
   (`dequeue` → `FOR UPDATE SKIP LOCKED`) and runs `makeTermsGatedIngestJobHandler`
   (terms/robots gate → adapter → `ingestSource`). Retry/backoff + dead-letter via `core/queue`.

**Cadence tiers are config-not-code** — they live in the `source` table
(`baseline_cadence` + nullable `near_date_cadence`), effective cadence =
`COALESCE(near_date_cadence, baseline_cadence)`:

| Tier | Families (seed) | Effective cadence |
|---|---|---|
| Hot | `activenet` | near-date **1 h** |
| Warm | `perfectmind` | near-date **2 h** |
| Daily/cold | `library_*`, `city_calendar`, `venue_html` | baseline **1 day** |
| Seasonal | `seasonal_watcher` | baseline **7 days**, near-date **1 day** |

The 60 s tick comfortably honours the smallest (1 h) cadence. Because policy is DB-driven, the
same worker automatically respects future cadence edits with no redeploy.

**Resilience (important):** the loops never let a DB error kill the process — a transient
connectivity failure is caught, recorded in `scheduler.lastError`, and retried; `/healthz`
**always returns 200** for liveness so a DB blip never makes the Fly machine un-healthy. (This
fixed a real crash found during Docker validation — see §5.)

### Files changed (worker only)

| File | Change |
|---|---|
| `worker/src/scheduler.ts` | **new** — tick loop + resilient queue loop + live metrics |
| `worker/src/db.ts` | **new** — pool factory; TLS on for Supabase, off for localhost |
| `worker/src/index.ts` | wire scheduler into the entrypoint; graceful SIGTERM shutdown |
| `worker/src/healthz.ts` | surface scheduler metrics in the `/healthz` payload |
| `worker/fly.toml` | add `APP_ENV="staging"`; refresh the (now stale) "deploy deferred" comment |

## 4. Database endpoint decision

The vault `db_url` (and `user_database_url`) resolve to the Supabase **direct** host
`db.mdusztrunwnniwnpwsmy.supabase.co:5432`, which is **IPv6-only**. The host machine resolves it,
but the Docker **bridge** network (IPv4) cannot → `getaddrinfo ENOTFOUND` inside the container.

**Chosen endpoint:** the Supabase **session pooler**
`aws-0-ca-central-1.pooler.supabase.com:5432` (user `postgres.<ref>`), which is **IPv4 and works
everywhere** — Docker bridge and Fly. Verified reachable (both 6543/txn and 5432/session);
session mode chosen for a long-lived worker holding a small persistent pool. This matches the
repo's recent "switch staging DB URLs to Supabase pooler" direction.
*Follow-up (non-blocking):* persist this pooler URL as a dedicated vault field.

## 5. Local validation

**Source used:** `Richmond Public Library BiblioEvents` (`library_bibliocommons`, id
`da41ed05…`) — already `terms_status=allowed` / `robots_status=allowed` in staging, and
**fixture-only** by default (`isLiveFetchEnabled` is gated behind `KIDS_FUN_LIVE_LIBRARY_SYSTEMS`
which was left unset). So the cycle exercised the full pipeline with **no live external fetch and
no terms decision made.**

| Check | Result |
|---|---|
| Worker `tsc` build | ✅ exit 0 |
| Local node run (staging DB) | ✅ `/healthz` 200; tick enqueued RPL; `jobsProcessed:1/succeeded:1`; `source_check_run` 8→9 (`success`, `records_found:1`) |
| `docker build` | ✅ image 1.34 GB |
| Docker run (bridge, pooler) | ✅ `/healthz` 200, **`chromiumReady:true`**; enqueued+ingested 2 due sources; `jobsSucceeded:2/failed:0`; check_run 9→10 |
| Resilience (unreachable DB) | ✅ container stays `running`, `/healthz` 200, `chromiumReady:true`, error captured in `scheduler.lastError` — **no crash** (this exposed & fixed the earlier `Promise.all` crash) |

Occurrence count held at 21 across cycles → idempotent upsert confirmed (same fixture record
upserts in place, no duplicates).

## 6. Live (Fly) validation

| Check | Result |
|---|---|
| `fly deploy` | ✅ machine `891242a6431232` created in `yyz`, update `success` |
| Machine health check | ✅ `1 total, 1 passing` |
| `GET /healthz` (internet) | ✅ HTTP 200, `scheduler.enabled:true`, `environment:staging`, `lastError:null` (pooler DB reachable from Fly) |
| `GET /smoke` (Chromium) | ✅ `{"ok":true,"title":"kids-fun-smoke"}` — headless render works on the machine |
| Live scheduler cycle | ✅ after re-arming RPL, the live 60 s tick enqueued + ingested it: `ticks:3, totalEnqueued:1, jobsProcessed:1, jobsSucceeded:1`; DB `source_check_run` 10→11 (`success`, 146 ms); `next_check_at` advanced +1 day |

> `chromiumReady` reads `false` immediately post-boot (the boot smoke hasn't finished) and flips
> `true` once it completes / after `/smoke`; confirmed `true` at uptime 193 s.

## 7. Repo verification (all green)

| Command | Result |
|---|---|
| `cd worker && npm run build` (tsc) | ✅ exit 0 |
| `npm run typecheck` (root) | ✅ exit 0 |
| `npm run lint` (root, `eslint .`) | ✅ exit 0 |
| `npm test` (root, `vitest run`) | ✅ 133 passed / 52 skipped (DB-gated) / 26 files; exit 0 |

## 8. Cost & scope notes

- **1 machine running** (`shared-cpu-1x`/1 GB, `yyz`, `min_machines_running=1`) — this is the
  continuous staging scheduler and sits within Jon's approved "staging Fly worker, ca-central-1"
  scope. Ongoing cost is small (~a few $/mo at 24/7). If Jon prefers **$0 until M1**, one command
  parks it: `fly scale count 0 -a kids-fun-worker-staging` (redeploy/`scale count 1` to resume).
- **No prod resources created.** Staging-only throughout. No G1–G7 milestone gate self-approved.
- Secrets never printed; the DB URL was piped to Fly over stdin.

## 9. Standing to-dos surfaced (for the batch owner)

1. `docs/infra.md` Fly row + `fly.toml` header say "deploy deferred / BLOCKED" — now stale.
2. Consider a dedicated `worker_database_url` (pooler) field in the `kids-fun-supabase-staging`
   vault entry so deploys don't reconstruct it.
3. `KIDS_FUN_LIVE_LIBRARY_SYSTEMS=rpl` enables *live* RPL fetching (D-6). Left **off** here.
