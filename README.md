# KIDS FUN

Aggregator of kid-friendly activities in the GVRD.
Metro Vancouver kids-activity discovery index. Next.js (App Router, TypeScript) on Vercel,
Supabase (managed Postgres + PostGIS + FTS + Auth) for data, a containerised ingestion
worker for browser-rendered sources, Resend for email, Sentry for observability.

Canonical scope: `documents/requirements/jon-cartwright/kids-fun-scope-to-task-v1.1.md`
(satellite) · TSD v1.2 · PRD v1.2.

## Layout

| Path | Purpose |
|---|---|
| `app/` | Next.js App Router (hello-world foundation; search UX lands M2–M3) |
| `supabase/migrations/` | Single forward-only schema tool (canonical schema starts G-T2-1) |
| `scripts/migrate.sh` | Idempotent migration runner (CI + deploy) |
| `worker/` | Containerised ingestion worker — Node + headless Chromium (NOT Vercel serverless) |
| `.github/workflows/ci.yml` | CI: migrations + typecheck + lint + unit on every PR |
| `docs/infra.md` | Environments, hosting, provisioning runbook |
| `docs/credentials.md` | Vault slug registry (names only — never values) |
| `lib/snapshot/` + `scripts/snapshot/` | Anonymised production-catalogue snapshots for testing against real data shapes |
| `docs/prod-snapshot-runbook.md` | Operator runbook for producing, verifying and scheduling those snapshots |

## Local dev

```bash
npm install            # app deps
npm run dev            # next dev
npm run migrate        # apply migrations (needs DATABASE_URL + psql)
npm run test           # full suite — parallel no-DB lane + serial shared-Postgres lane
npm run test:unit      # just the parallel lane (no database needed)
npm run test:db        # just the serial shared-Postgres lane
cd worker && npm install && npm run build && npm start   # worker on :8080
```

The suite runs in two lanes (`vitest.workspace.ts`): the DB-backed integration suites share
one Postgres and must run one file at a time; everything else runs fully parallel. A bare
`npx vitest run` still works and is still safe — it just serialises everything, which is
what `npm run test` exists to avoid.

### Testing against real data shapes (opt-in)

Fixtures only contain what somebody thought to put in them, so they cannot catch data-shape
drift. `npm run test:snapshot` loads an anonymised snapshot of the real catalogue and runs the
DB lane against it. Fixture mode stays the default; nothing above changes.

The snapshot exports **twelve catalogue tables only** — the searchable index scraped from
public websites. User and account tables (`user_profile`, `saved_search`, `analytics_event`, …)
are never exported at all, because a table that is never read cannot leak. The allowlist lives
in `lib/snapshot/policy.ts` and is enforced on every CI run by
`tests/snapshot/policy-schema-guard.test.ts`, which fails loudly if a migration adds an
unclassified column to an allowlisted table.

Producing a snapshot needs production database access and is an Operator task:
**`docs/prod-snapshot-runbook.md`**. The whole pipeline can be rehearsed locally with no
production access at all — see §11 of that runbook.

## Environments

`local/dev` · `staging` · `production` (TSD §3A.3). Secrets are injected per-environment
from the Credential Vault — none are committed. See `docs/infra.md`.
