# KIDS FUN — Infrastructure

Source: TSD v1.2 §3A.1 / §3A.3 / §3.5 · scope-to-task v1.1 §C (G-T1-1..G-T1-4).

**Last verified against live infrastructure: 2026-07-21 (Round 30).** This doc previously described only
the 2026-07-13 Wave-0 bring-up state and was badly stale — production has existed and been live since
Round 28 (2026-07-21), which this update reflects. If you find this doc drifting from reality again, treat
that as its own real finding, not a nitpick — a stale infra doc misled an independent QA pass earlier
tonight into believing production didn't exist.

## Environments (three-env model)

| Env | Frontend (Vercel) | Data (Supabase) | Worker | Notes |
|---|---|---|---|---|
| local/dev | `next dev` | developer's own project / local | local `node`/docker | Developer-owned |
| **staging** | `kids-fun-staging` | `kids-fun-staging` | `kids-fun-worker-staging` | Real adapters vs small source allow-list |
| **production** | `kids-fun` | `kids-fun-prod` | `kids-fun-worker` | Terms-gated source enablement — **LIVE since Round 28 (2026-07-21)** |

- Framework: Next.js App Router + TypeScript on Vercel. Node 20 LTS.
- Data: Supabase managed Postgres (+ PostGIS, `pg_trgm`, FTS added in M0 Wave 2 T4).
- Worker: long-running/containerised Node + headless Chromium (Fly.io). **Not** Vercel serverless
  (TSD §3A.1). See `worker/`.
- Migrations: single tool, forward-only with reversible steps (`scripts/migrate.sh`).
  App code auto-deploys (Vercel git); migrations are applied manually — so a
  read-only drift check (`scripts/check-migration-drift.sh`) + scheduled workflow
  guard against the live DB silently falling behind the committed head. See
  `docs/migration-drift.md`.
- Both the staging and production Vercel projects track the SAME `main` branch — a single push
  deploys to both simultaneously. There is no separate "production" git branch.

## Provider accounts (confirmed access — reused MyZone credentials)

| Provider | Vault slug | Account / scope | Status |
|---|---|---|---|
| Vercel | `vercel` | team `JDCInc` (`jdci-nc`, `team_GvqNex1Ppl55vbBZqI6k58un`) — approved scope | token valid |
| Supabase | `supabase-management` (org PAT) | org `JDC000000's Org` (`tpzqvsfdunawnibnihlb`) | token valid |
| Fly.io | `fly-io` | `personal` org | org-scoped, can create + deploy apps |
| GitHub push | `kids-fun-github-personal-repo` | `JDC000000/kids-fun-github-jdcinc` (private repo) | the ONLY working push credential as of Round 30 — `github` and `kids-fun-github-jdcinc` vault slugs are dead/expired, do not use them |

Existing projects in these accounts (do not disturb): Vercel — 24-hours-of-power, the-wip,
curious-if, stem-loops-web, stem-loops. Supabase — Stem-Loops, the-wip, Curious If,
24-hours-of-power (all `us-east-1`, org already on a paid plan).

**Merge/deploy identity requirement:** all merge commits to `main` MUST be authored+committed as
`JDC000000 <216232139+JDC000000@users.noreply.github.com>` — Vercel's Hobby-plan git integration
silently BLOCKs (no build error, just never deploys) any commit from a different author. This applies
to preview deployments too, not just production merges.

## Live provisioning status — 2026-07-21 (Round 30, current)

| Resource | Status | Identity |
|---|---|---|
| Supabase staging project | ✅ **LIVE** | `kids-fun-staging`, ref `mdusztrunwnniwnpwsmy`, region `ca-central-1`, PG17. Keys in vault `kids-fun-supabase-staging`. Fully populated (4 live sources, real occurrence data). |
| Supabase prod project | ✅ **LIVE since Round 28** | `kids-fun-prod`, ref `rnqaofjhiqmqaipqpiua`, region `ca-central-1`. Keys in vault `kids-fun-supabase-prod`. Migrated to head, reference-seeded, 4 sources live (city calendar, VPL, RPL, H.R. MacMillan Space Centre) with real occurrence data. |
| Vercel staging project | ✅ **LIVE** | `kids-fun-staging` (`prj_dCwLkWiBZGRlrz6EWmzaevP8uIuC`), domain `kids-fun-staging-jdci-nc.vercel.app`. Tracks `main`. |
| Vercel prod project | ✅ **LIVE since Round 28** | `kids-fun` (`prj_Fj1RUODfCLbPDEavBNX6k778br5W`), domain `kids-fun-psi.vercel.app`. Genuinely separate project/env vars from staging (not a shared config). Tracks `main`. |
| Fly.io worker (staging) | ✅ **LIVE** | `kids-fun-worker-staging`, region `yyz` (ca-central-1 alignment), `shared-cpu-1x`/1024mb, 1 machine. |
| Fly.io worker (prod) | ✅ **LIVE since Round 28** | `kids-fun-worker`, region `yyz`, `shared-cpu-1x`/1024mb, 1 machine (matches staging size, Jon-approved). |
| GitHub repo + push | ✅ **LIVE** | `JDC000000/kids-fun-github-jdcinc`, private. Push via vault slug `kids-fun-github-personal-repo` only. |
| CI on PR | ✅ **LIVE** | `.github/workflows/ci.yml` runs on every PR. |
| Sentry | ✅ **LIVE** | Shared Sentry project across web + Fly worker, distinguished by `environment` and `app_runtime` tags. Fly apps `kids-fun-worker-staging` + `kids-fun-worker` both have the `SENTRY_DSN` secret set (2026-07-21). Serverless API routes on the core search/results path now use `withObservedRoute` / explicit `captureAndFlush`; admin/cron utility routes remain lower-priority auto-instrumented surfaces. |

Remaining known gaps (tracked, not blocking):
- Map view (`/search`) shows an honest "not available" fallback in both environments — `NEXT_PUBLIC_MAP_KEY`
  was never wired into either Vercel project's env vars, even though a Mapbox credential exists in the vault
  (`kids-fun-mapbox`). Low-risk, whenever prioritized. (evals/bugs.json BUG-007/BUG-018)
- Most non-enabled source families (activenet, perfectmind, library_communico, seasonal_watcher, the
  eventbrite placeholder) remain `terms_status=pending`, correctly gated pending real terms/robots review
  per source — not a bug, expected state.
