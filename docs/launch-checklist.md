# KIDS FUN — Launch Checklist (production coverage + monitoring)

> **PROVENANCE NOTE, added 2026-08-10.** This file was recovered byte-identical from
> commit `1147a89` (unreachable from every branch/remote at the time, one `git gc` from
> permanent loss) and committed here to fix that. **Owner: the Operator role** — reviewed
> at every Operator rotation handoff and again before any launch go/no-go. The deferred
> Vercel Hobby→Pro upgrade decision (G-T39-4) is tracked here, not actioned; do not treat
> its presence in this file as approval to upgrade. See canonical capsule / live cycle
> state memory for current status.
>
> **KNOWN-STALE CLAIMS, added 2026-08-10 (two caught the same day, same direction — this
> file under-reports what has since actually been done; read it as a 2026-07-20 snapshot,
> never as current state):**
> 1. This file's headline describes production as an empty, partially-migrated shell with
>    zero terms-approved sources. **False as of 2026-08-10** — `docs/infra.md`'s Round-28
>    entry (2026-07-21) and independent Operator verification confirm 4 sources are live in
>    production with real occurrence data (626 live occurrences at last check).
> 2. This file records migration `0019_llm_batch_run` as applied to **neither** prod nor
>    staging. **False as of 2026-08-10** — Operator-verified directly against both live
>    databases: applied to both (prod head 0027, staging head 0028 at last check).
> Do not treat either of the original claims below as current without re-verifying against
> live infra; this file is not self-updating.
>
> **THIRD KNOWN-STALE CLAIM, added 2026-08-11, and this one is operationally significant:**
> 3. Line 59 (approx) claims "No separate `kids-fun` prod project/deploy. The only project's
>    Vercel production target is still staging-wired," and names a different staging domain
>    than `docs/infra.md` does. **False as of 2026-08-11** — Operator-verified directly
>    against the Vercel API: `kids-fun` (`prj_Fj1RUODfCLbPDEavBNX6k778br5W`) is a genuinely
>    separate production project, its production branch is `main`, and its verified custom
>    domain is `kids-fun-psi.vercel.app` — matching `docs/infra.md`, not this file.
>    **THE PART THAT MATTERS GOING FORWARD:** this project **auto-deploys to production on
>    every push to `main`** — confirmed by matching production-deployment commit SHAs one
>    for one against every push made on 2026-08-10/11 (`aa14057`, `3b36ebb`, `72b9e19`,
>    `fa06c6b`, `f0356c7`, `8fe6268`, `ba8739f`, all present as their own production
>    deployment). **This is unlike the Fly worker, which requires a manual, separately
>    authorised `fly deploy`.** A merge to `main` is therefore a production release of the
>    web app in the same action — there is currently no equivalent manual gate. Treat every
>    future merge accordingly until/unless that changes.

**Task:** Round 27 / G-T39-1 — production coverage seeded + monitored (verify real launch
sources are live in **production**, not just staging; confirm Sentry + monitoring dashboards
are genuinely populated with real production data).
**Autonomy:** ‹L3› real-time-review. This document records what was **found** and **done**;
it does **not** stand up production, enable sources in production, or record the go/no-go
(that is **G-T39-4**, reserved for Jon).
**Author:** Developer Ops. **Date:** 2026-07-20. **Method:** direct verification against the
live credential-vault-backed environments (Supabase prod + staging via `db_url`, Vercel API,
Fly.io GraphQL, live deployed bundle fetch) — not doc/config inference.

---

## 0. Headline

**The canonical AC is NOT met, and the gap is NOT a self-closeable deploy-drift row.**

There is **no functioning production environment** for KIDS FUN today. The only live,
running, data-carrying environment is **staging**. The production Supabase project exists
but is an **empty, partially-migrated shell** that nothing deploys to and nothing runs
against. Standing production up (seed + migrate-to-head + enable live sources against a real
prod worker + point a prod deploy at it) **is the launch itself** — i.e. exactly the
**G-T39-4 go/no-go decision reserved for Jon**, and (for live third-party fetching in a brand
new environment) a real ToS/politeness/launch-readiness judgment call under this project's
standing L3 discipline. **Developer Ops made zero live changes** and is flagging this to the
orchestrator + Jon rather than deciding it.

Staging, by contrast, is fully covered + monitored and passed every check below.

---

## 1. Environment topology (verified 2026-07-20)

| Component | Staging | Production |
|---|---|---|
| **Supabase DB** | ✅ LIVE — ref `mdusztrunwnniwnpwsmy`, `ca-central-1`, PG17. Migrations **18/18** (head `0018_public_tables_default_deny_rls`). Seeded + real ingested data. | ⚠️ **EXISTS but EMPTY** — ref `rnqaofjhiqmqaipqpiua`, credential `env=production`. Schema present but migrations **only 16** (head `0016_activity_series_identity`). **0 sources, 0 activity, 0 provenance, 0 check-runs.** |
| **Vercel app** | ✅ project `kids-fun-staging` (`prj_dCwLkWiBZGRlrz6EWmzaevP8uIuC`), domain `kids-fun-ashy.vercel.app`, `/api/health` → `env=staging`, `commit=f7ec772`. | ~~❌ No separate `kids-fun` prod project/deploy. The only project's Vercel "production" target is still staging-wired (`env=staging`).~~ **CORRECTED 2026-08-11, INLINE — this row itself was the thing that misled a reader, not just the file's headline: `kids-fun` IS a genuinely separate production project (`prj_Fj1RUODfCLbPDEavBNX6k778br5W`), domain `kids-fun-psi.vercel.app`, auto-deploys from `main`. See the provenance note's stale-claim #3 at the top of this file for full detail — do not trust this cell alone, and do not trust the top note alone; a reader hitting only one of the two got exactly this wrong once already tonight.** |
| **Fly.io worker** | ✅ `kids-fun-worker-staging` (org personal, `deployed=true`) — real, recent successful `source_check_run`s. | ❌ **No `kids-fun-worker` prod app exists.** |

> `docs/infra.md` (Wave-0 dated 2026-07-13) still says "prod Supabase not created". That is
> **stale**: a real, fully-credentialed prod Supabase project now exists (`kids-fun-supabase-prod`
> vault slug is fully populated). But it was never migrated to head, never seeded, and has no
> app/worker in front of it.

### 1.1 Production migration gap (on top of being empty)

Production is behind on migrations by 2–3, including a **security** migration:

| Migration | In staging | In prod | Notes |
|---|---|---|---|
| `0017_weekly_email_send` | ✅ | ❌ | weekly-email send bookkeeping |
| `0018_public_tables_default_deny_rls` | ✅ | ❌ | **default-deny RLS on public tables — security lockdown.** Prod would launch without it. |
| `0019_llm_batch_run` | ❌ (deferred; LLM batch disabled) | ❌ | committed to repo; not applied to *either* env (LLM_BATCH disabled). Minor. |

Standing prod up therefore **must** apply 0017 + 0018 (at minimum) before any launch — this
is another reason the gap is not a "flip one flag" catch-up.

---

## 2. Terms-approved sources — DB truth (staging)

Live-eligible = `terms_status ∈ {allowed, summarise_only}` **AND** `robots_status = 'allowed'`
(gate: `worker/core/terms-gate.ts`). **Staging** `source` table:

| # | Family / Name | terms_status | robots_status | Live-verified in staging |
|---|---|---|---|---|
| 1 | `city_calendar` / City of Vancouver events calendar | allowed | allowed | ✅ `source_check_run` success, `next_check` 2026-07-21 |
| 2 | `library_bibliocommons` / Vancouver Public Library BiblioEvents | allowed | allowed | ✅ success, real data |
| 3 | `library_bibliocommons` / Richmond Public Library BiblioEvents | allowed | allowed | ✅ success, real data |
| 4 | `venue_html` / H.R. MacMillan Space Centre | allowed | allowed | ✅ enabled Round 23 / Task OO; success, `next_check` 2026-07-21 |

All other rows (activenet ×3, perfectmind ×2, seasonal ×3, Science World, Vancouver Aquarium,
Eventbrite placeholder, library_communico, plus test fixtures) are `pending/pending` — correctly
fixture-only, gate-blocked. Staging data volume: **104 activity_series, 134 activity_occurrence,
697 provenance rows.** No staging deploy-drift found — every terms-approved staging source is
genuinely live.

> Classification note: `docs/source-register.md` §2 classifies VPL/RPL as **summarise-only**;
> the DB marks them `allowed`. Both satisfy the gate (`terms_status ∈ {allowed, summarise_only}`),
> so this is a labelling nuance, not a gate failure. Worth reconciling for the register, non-blocking.

### 2.1 Terms-approved sources in PRODUCTION

**Zero.** The prod `source` table is empty — not even the `pending` seed rows exist. No source
is terms-approved in prod, and none can be live there. The seed
(`supabase/seeds/sources.sql`) was **never applied to prod**.

---

## 3. Sentry — direct live-bundle verification (Round 24 / Task UU method)

**✅ Genuinely live and capturing** — verified the way Round 24 verified it: not by checking an
env var, but by confirming the DSN is **inlined in the live deployed browser bundle**.

- Fetched `https://kids-fun-ashy.vercel.app/` → parsed `/_next/static/chunks/` → the Sentry
  DSN ingest host **`o4511723449483264.ingest.us.sentry.io`** is present in `main-app-*.js`.
- Wiring (`instrumentation-client.ts`): `Sentry.init({ dsn, enabled: Boolean(dsn), ... })`,
  PII-scrubbed (`sentry.scrub.ts`), `owner_team:kids-fun` tag. Alert rules exist (Round 13
  Task L2, `environment:null` → env-agnostic, so they will catch prod too once it exists).

**Caveat for go/no-go:** the captured `environment` tag is **`staging`** (`NEXT_PUBLIC_APP_ENV`),
because staging is the only deployment. There is **no production-tagged Sentry stream** because
there is no production deploy. Sentry *wiring* is proven; production *coverage* awaits a prod deploy.

---

## 4. Monitoring dashboards

Routes exist and read live DB data (not fixtures): `/admin/dashboard` (KPI tiles via
`lib/admin/dashboard` + `lib/analytics/kpi`) and `/admin/data-health` (region × family
CoverageMatrix, SLA, corrections queue via `lib/admin/data-health`). Gated by
`ADMIN_DASHBOARD_TOKEN` (`x-admin-token` header / `?token=`).

- **✅ Staging:** both render live (HTTP 200; real coverage/source/occurrence content) — the
  monitoring mechanism genuinely works and is populated on the live env.
- **❌ Production:** cannot be populated — the prod DB is empty and there is no prod deploy to
  serve the dashboards from.

---

## 5. Coverage-or-gap summary (for T39-2 sequencing + Jon's T39-4 brief)

| AC clause | Staging | Production | Verdict |
|---|---|---|---|
| Real launch sources live | ✅ 4 sources, verified | ❌ 0 (empty DB, no worker) | **NOT MET in prod** |
| Sentry live + capturing | ✅ DSN in live bundle | ❌ no prod-tagged deploy | Wiring proven; prod coverage pending |
| Monitoring dashboards populated with real data | ✅ live, real data | ❌ empty | **NOT MET in prod** |
| DB migrated to head | ✅ 18/18 | ❌ 16 (missing 0017/0018-RLS) | **NOT MET in prod** |

**T39-2 (full regression):** can and should run against **staging** (populated, at head) — the
regression suite (130+ vitest + Playwright e2e + worker smoke) needs a live Supabase/`DATABASE_URL`;
staging is the correct target. Production is not a valid regression target (empty/behind).

**T39-4 (go/no-go — Jon):** the production launch has **not been performed**. Bringing prod up is
a Jon decision, and involves at minimum: (a) migrate prod to head incl. `0018` default-deny RLS;
(b) seed prod `source` rows; (c) make the terms/robots enablement decision for prod (which of the
4 staging-approved sources go live in prod, and whether VPL/RPL should be `summarise_only` vs
`allowed`); (d) stand up a prod Vercel deploy + prod Fly worker (`kids-fun-worker`) with the env
allow-lists (`KIDS_FUN_LIVE_CITY_CALENDARS`, `KIDS_FUN_LIVE_LIBRARY_SYSTEMS`, `KIDS_FUN_LIVE_VENUES`);
(e) set `NEXT_PUBLIC_APP_ENV=production` so Sentry captures a prod stream. This is the launch — not
a config catch-up — so it stays with Jon.

---

## 6. Explicitly out of scope / not touched

- **T7 (ActiveNet) and T8 (PerfectMind):** parked pending Jon's separate legal/licensing
  decisions. Confirmed `pending/pending` in staging; not touched, not enabled, regardless of findings.
- **No self-close performed.** The one gap that *would* have been self-closeable — a
  terms-approved-but-not-live source (deploy-drift catch-up) — does **not** exist: staging has no
  such drift, and prod has no sources at all. The actual prod gap (whole-environment not stood up)
  is a Jon-level launch decision, not a drift flip. **Zero live production changes were made.**

---

## 7. Verification evidence (all read-only)

- Prod + staging `source` / `activity_*` / `provenance` / `source_check_run` / `schema_migrations`
  queried directly via `psql` over the vault `db_url` (service connection; no secret echoed).
- Vercel projects/deployments via `api.vercel.com` (team JDCInc); Fly apps via `api.fly.io/graphql`.
- Sentry DSN confirmed by fetching the live `/_next/static/chunks/main-app-*.js` and matching the
  ingest host. `/api/health` on the live deploy → `{env:"staging", commit:"f7ec772..."}`.
- Live admin dashboards fetched with `ADMIN_DASHBOARD_TOKEN` → HTTP 200 with real data content.
