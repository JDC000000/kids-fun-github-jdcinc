# KIDS FUN — Infrastructure

Source: TSD v1.2 §3A.1 / §3A.3 / §3.5 · scope-to-task v1.1 §C (G-T1-1..G-T1-4).

## Environments (three-env model)

| Env | Frontend (Vercel) | Data (Supabase) | Worker | Notes |
|---|---|---|---|---|
| local/dev | `next dev` | developer's own project / local | local `node`/docker | Developer-owned |
| **staging** | `kids-fun-staging` | `kids-fun-staging` | `kids-fun-worker-staging` | Real adapters vs small source allow-list |
| **production** | `kids-fun` (prod) | `kids-fun-prod` | `kids-fun-worker` | Terms-gated source enablement |

- Framework: Next.js App Router + TypeScript on Vercel. Node 20 LTS.
- Data: Supabase managed Postgres (+ PostGIS, `pg_trgm`, FTS added in M0 Wave 2 T4).
- Worker: long-running/containerised Node + headless Chromium (Fly.io/Railway-class or
  satellite-hosted process). **Not** Vercel serverless (TSD §3A.1). See `worker/`.
- Migrations: single tool, forward-only with reversible steps (`scripts/migrate.sh`).

## Provider accounts (confirmed access — reused MyZone credentials)

| Provider | Vault slug | Account / scope | Status |
|---|---|---|---|
| Vercel | `vercel` | team `JDCInc` (`jdci-nc`, `team_GvqNex1Ppl55vbBZqI6k58un`) — approved scope | token valid (rotated 2026-07-13) |
| Supabase | `supabase-management` (org PAT) | org `JDC000000's Org` (`tpzqvsfdunawnibnihlb`) | token valid |
| Fly.io | `fly-io` | `personal` org | deploy-scoped only — **cannot create apps** |

Existing projects in these accounts (do not disturb): Vercel — 24-hours-of-power, the-wip,
curious-if, stem-loops-web, stem-loops. Supabase — Stem-Loops, the-wip, Curious If,
24-hours-of-power (all `us-east-1`, org already on a paid plan).

## Live provisioning status — 2026-07-13 (Wave 0, gates approved by Jon)

Approved gates: **Supabase staging only** (not prod) · **Vercel team JDCInc** · region
**ca-central-1** · worker runtime **Fly.io** · GitHub **private repo `JDCInc/kids-fun`**.

| Resource | Status | Identity |
|---|---|---|
| Supabase staging project | ✅ **LIVE** | `kids-fun-staging`, ref `mdusztrunwnniwnpwsmy`, region `ca-central-1`, PG17. Keys in vault `kids-fun-supabase-staging`. |
| Supabase prod project | ⛔ not created (gate: staging only) | deferred |
| Vercel project | ✅ **LIVE** | `kids-fun-staging` under team JDCInc (`prj_dCwLkWiBZGRlrz6EWmzaevP8uIuC`). Staging Supabase env vars wired. No deployment yet (no git link → no cost). |
| Fly.io worker app | ⛔ **BLOCKED** | `fly-io` token is deploy-scoped; cannot create `kids-fun-worker-staging`. Needs org-scoped token (secure form requested). Image + config validated locally. |
| GitHub repo + push | ⛔ **BLOCKED** | stored `github` PAT returns HTTP 401 (revoked). Needs a valid classic PAT with `repo`+`admin:org` (secure form requested). Repo is local-only at `27a0f47`. |
| CI on PR | ⛔ **BLOCKED (on GitHub)** | `.github/workflows/ci.yml` authored + migration harness validated locally; will run once the repo is pushed. |

Remaining bring-up once the two blocked credentials land:

```bash
# GitHub (once a valid PAT is in the `github` connector):
#   create private repo JDCInc/kids-fun -> git push -u origin main --tags -> CI runs on PR.
#   Link the repo to the Vercel project (kids-fun-staging) for preview deploys.
# Fly.io (once an org-scoped token is in the `fly-io` connector):
#   fly apps create kids-fun-worker-staging (or Machines API) — deploy deferred to M1.
# Smoke: GET /api/health (web) 200; worker /healthz 200 + /smoke PASS.
```
