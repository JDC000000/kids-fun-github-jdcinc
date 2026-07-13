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
| Vercel | `vercel` | `jdc000000` (personal) · team `JDCInc` (jdci-nc) available | token valid |
| Supabase | `supabase-management` (org PAT) | org `JDC000000's Org` (`tpzqvsfdunawnibnihlb`) | token valid |
| Fly.io | `fly-io` | `personal` org | deploy token valid |

Existing projects in these accounts (do not disturb): Vercel — 24-hours-of-power, the-wip,
curious-if, stem-loops-web, stem-loops. Supabase — Stem-Loops, the-wip, Curious If,
24-hours-of-power (all `us-east-1`, org already on a paid plan).

## Provisioning runbook (live create — gated on operator go)

The config-first deliverables (this repo) are complete. Live project creation is **gated**
because it is a spend/ownership decision (§ below). To provision once approved:

```bash
# 1. Vercel projects (free). Choose scope: personal (jdc000000) or team JDCInc.
#    Create kids-fun-staging + kids-fun (prod); set NEXT_PUBLIC_APP_ENV per env; deploy.
# 2. Supabase projects (RECURRING SPEND — org is on a paid plan). Create
#    kids-fun-staging + kids-fun-prod in org tpzqvsfdunawnibnihlb; choose region.
# 3. Worker: fly launch/deploy worker/ (Fly app) OR run as satellite-hosted process.
# 4. Wire per-env env vars from the vault; run scripts/migrate.sh against each DB.
# 5. Smoke: GET /api/health (web) 200; curl worker /healthz 200 + /smoke PASS.
```

## Decisions needed before live provisioning (spend / ownership)

1. **Supabase spend** — create 2 new projects (staging + prod) in the paid org → recurring
   cost. Confirm go.
2. **Vercel scope** — personal (`jdc000000`, matches all existing MyZone projects) vs team
   `JDCInc`. Default suggestion: personal, to match THE WIP / 24HOP.
3. **Region** — existing projects are `us-east-1`; Metro Vancouver would favour `ca-central-1`
   (Supabase) / `pdx1`+`sea` (Vercel/Fly, Pacific NW). Confirm data-residency preference.
4. **Worker runtime** — Fly.io app (recurring spend, ~1GB VM for Chromium) vs Railway vs a
   satellite-hosted process. Default (D-3): Fly.io/Railway-class container.
5. **GitHub repo** — create remote repo + push (needed for CI to actually run on PRs) and
   under which account/org. Currently local-only (`/opt/projects/user/kids-fun`).
