# lib/testing — E2E test-session harness (TEST-ONLY)

**Not production code.** Nothing under `lib/testing/**` is imported by `app/**`,
`worker/**`, or any runtime path — it only supports the Playwright E2E suite
(`tests/e2e/**`). It is typechecked/linted like the rest of the tree.

It mints a **real** Supabase Auth session for a dedicated test user and serializes
it into cookies Playwright injects — so the E2E suite can drive authenticated,
auth-gated pages (`/account`, the saved-search flow) against the real app.

## Two enforced safety properties (QA verifies these specifically)

### 1. No app-level auth bypass; env-gated against production — `supabase-guard.ts` + `test-session.ts`
- The session is created by **reusing the service-role admin capability** (same
  pattern as `lib/db/auth-admin.ts`: `createClient(url, SERVICE_ROLE_KEY, …)` →
  `admin.auth.admin.*`) to provision a user, then a **normal GoTrue password
  grant** issues a genuine session. The app's auth code is exercised unchanged —
  there is **no** special header/query-param backdoor that skips real auth.
- `assertTestOnlySupabaseTarget()` is a **default-deny** gate run *before* any
  privileged call: only loopback Supabase URLs pass by default; a non-loopback
  host must be explicitly named in `E2E_ALLOWED_SUPABASE_HOSTS`; and
  `NEXT_PUBLIC_APP_ENV=production` is refused outright. A production project can
  never match by accident — it throws loudly (`UnsafeSupabaseTargetError`).
  Unit-verified in `tests/testing/supabase-guard.test.ts` (runs in `npm test`).

### 2. Auditable test user — `test-user.ts`
- Reserved, non-deliverable email domain `@e2e.kids-fun.test` (RFC 6761 `.test`
  TLD), enforced in code (the harness refuses any other email).
- A persisted marker (`{ is_e2e_test_user: true, created_by: 'kids-fun-e2e-harness', … }`)
  written to the auth user's `app_metadata`/`user_metadata`, queryable from
  `auth.users.raw_app_meta_data` and visible in the Supabase admin view.
- Unit-verified in `tests/testing/test-user.test.ts`; live-verified in
  `tests/e2e/authed/account.authed.spec.ts` against the real `auth.users` row.

## Files
- `supabase-guard.ts` — the default-deny safety gate (pure, dependency-free).
- `test-user.ts` — reserved domain + audit marker + email helpers.
- `test-session.ts` — `createTestUserSession()` (mint) + `sessionToStorageState()`
  (serialize via `@supabase/ssr`'s own cookie writer, so the format always matches
  what the app reads).
