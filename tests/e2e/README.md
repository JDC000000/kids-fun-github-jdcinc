# tests/e2e — Playwright E2E harness (Round 14 / Task N, G6)

Drives the **real** Next.js app in a headless browser — the capability every prior
auth-gated QA pass flagged as missing ("could not verify, no headless browser /
auth-mock harness"). Covers unauthenticated flows and, via a real injected
Supabase session, **authenticated** flows in both light and dark colour schemes.

## Run it (local)

```bash
npm run e2e:setup                 # supabase start + RLS role + writes .env.e2e.local
bash scripts/e2e/run-e2e.sh       # next build + start, then the whole E2E suite
# or target one project:
bash scripts/e2e/run-e2e.sh --project=authed-dark
```

`run-e2e.sh` builds+starts the app against the local stack and tears it down after.
If you already have the app running against the local Supabase env, just:
`npm run e2e`.

## Layout

- `auth.setup.ts` — the `setup` project. Mints a REAL session for the dedicated,
  clearly-flagged test user (service-role admin, behind the default-deny safety
  gate in `lib/testing/`) and writes `.auth/state.json` (storageState) +
  `.auth/user.json`. Authed projects depend on it; public projects do not.
- `public/*.public.spec.ts` — unauthenticated: `/search`, `/preview`, and the
  `/account` → sign-in redirect. No Supabase admin access needed.
- `authed/*.authed.spec.ts` — authenticated `/account` + saved-search rendering,
  plus a live check that the auth user carries the audit marker. Runs under both
  `authed` (light) and `authed-dark` (dark) projects.
- `a11y/*.a11y.spec.ts` — project-wide **WCAG AA accessibility audit** (axe-core via
  `@axe-core/playwright`). AUDIT-ONLY: records every violation, never asserts
  zero-and-fails. `routes.anon.a11y.spec.ts` audits the unauthenticated routes
  (`/`, `/search` ±query, `/preview`, `/preview/[id]`, `/activity/[id]`);
  `routes.authed.a11y.spec.ts` audits `/account` with the injected session. Each runs
  in both light and dark. Findings live in `docs/a11y-audit.md`; raw per-route axe
  JSON is written to `.artifacts/a11y/` (git-ignored). See `axe-helper.ts`.
- `helpers/db.ts` — Postgres fixtures (seed/clear a saved_search; read the auth
  user's audit marker).

## Naming contract
Playwright owns `*.spec.ts` / `*.setup.ts`; Vitest owns `*.test.ts`. The
extensions are disjoint so `npm test` never runs Playwright specs and vice-versa.

The accessibility audit extends this with a dedicated infix so its specs stay
disjoint from the functional suites: `*.anon.a11y.spec.ts` runs only under the
`a11y-anon` / `a11y-anon-dark` projects, and `*.authed.a11y.spec.ts` only under
`a11y-authed` / `a11y-authed-dark`. The existing `public` / `authed` project
regexes (`*.public.spec.ts`, `*.authed.spec.ts`) never match the `.a11y.spec.ts`
files, so the a11y sweep runs *in addition to* — never instead of — the functional
specs.

## Writing new tests
- Unauthenticated page → `public/<name>.public.spec.ts`.
- Authenticated page → `authed/<name>.authed.spec.ts` (session auto-injected;
  runs in light + dark). Read the test user via `readTestUser()` from `helpers/db`.

`.auth/` and `.artifacts/` are gitignored — they hold a real session token and
screenshots. Never commit them.
