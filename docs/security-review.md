# KIDS FUN — Security Review

- **Gate / task:** G-T38-1 (M6) · Round 20 / Task FF
- **Reviewer:** Developer Ops (delegated by Development Orchestrator, session cbda1fb7)
- **Date:** 2026-07-19
- **Commit reviewed:** `1b116f722013fd499f0e57d3caf5263228f8f0a7` = `main` @ Round 19 / Task BB (first real admin mutation surface). Branch `overnight/g-t38-1-security-review`.
- **Autonomy:** ‹L3› — this is security judgment. Trivially-safe issues may be fixed and noted; anything needing a real decision (an RLS gap, an authz bypass) is **flagged for the orchestrator / Jon**, not silently changed. **No product code was changed by this review** (docs-only).
- **Method:** read-only static inspection of the whole codebase — auth/session, every RLS-relevant migration, the admin gate + all three mutation surfaces, the analytics/PII data paths, the Sentry scrub, all 13 API routes, the search SQL layer, and the CI/scripts secret handling. Built on (and independently re-verified) the Round 18/19 QA findings; did not merely trust the prior passes.

---

## Summary of findings

| # | Area | Finding | Severity | Status |
|---|------|---------|----------|--------|
| **F-1** | RLS / Admin authz | ~18 of 23 `public` tables have **no RLS and no REVOKE**, while `supabase/config.toml` exposes the whole `public` schema via REST **and** GraphQL. On Supabase's default grants (which the repo's *own* migration 0014 documents as real), a signed-in `authenticated` user could write to catalog/ops tables **directly, bypassing the admin gate + audit log**, and `anon` could read `analytics_event` / `correction_report` free-text. | **HIGH** (conditional on live project config — verification step given) | 🚩 **Flagged** — needs a decision + a 30-second prod check |
| **F-2** | PII / Sentry | The Sentry scrub deny-list does not cover **this product's** two most sensitive fields — home postal code and child ages — by key name or value pattern. Currently latent (no code path sends them to Sentry), but a defense-in-depth gap for a kids' product. | LOW–MED (latent) | 🚩 Flagged (recommended hardening) |
| **F-3** | Auth | `GET /auth/signout` performs a state change on a GET → **logout CSRF** possible. Already documented in-code as a deferred hardening item. | LOW | 🚩 Flagged (accepted/deferred) |
| **F-4** | Auth | The OAuth `next` redirect param is not validated as a relative path. **Currently neutralised** by the server-derived `origin` prefix, but brittle. | INFO | Noted |
| **F-5** | Secrets / infra | DB pool uses `ssl: { rejectUnauthorized: false }`. Standard Supabase pattern; theoretical MITM-on-DB only. | INFO | Noted |

**Everything else reviewed came back clean.** The application-layer security on this codebase is genuinely strong and carefully documented. The one material finding (F-1) is a **database-layer** gap that sits *underneath* the (airtight) app-layer admin gate — see below.

---

## Area 1 — Auth (Google OAuth + session handling)

**What I checked:** `app/auth/{signin,callback,signout}/route.ts`, `lib/db/auth.ts`, `lib/db/session-user.ts`, `lib/db/session.ts`, `middleware.ts`, and every caller of `getRequestUser()`.

**Findings — clean, with two low/info notes:**

- **OAuth flow is sound.** Sign-in is **server-initiated** (`GET /auth/signin` → `supabase.auth.signInWithOAuth`), so the PKCE `code_verifier` is set as a server cookie and the flow round-trips through `/auth/callback` → `exchangeCodeForSession`. First-login provisioning (`ensureUserProfile`) is best-effort and never blocks the redirect; `/api/me` self-heals a missing profile.
- **The `SUPABASE_ANON_KEY` is not shipped to the browser.** It is used only in server route handlers, `lib/db/auth.ts`, and test helpers — there is no `NEXT_PUBLIC_SUPABASE_*` and no client-side Supabase client. This meaningfully reduces the external attack surface (see F-1's exploitability note) even though the anon key is publishable by design.
- **`getRequestUser()` never throws** — anonymous / unset env / expired cookie all resolve to `null`. Callers choose the consequence (probe → anonymous body, write → 401, page → redirect). Cookie writes during a Server Component render are swallowed correctly.
- **The anonymous session id (`kf_anon_id`)** is a bare UUID, `httpOnly` + `sameSite=lax`, explicitly documented as **never an authorization boundary** — nothing in RLS or the admin checks keys off it. Middleware only ever mints/normalises it, never overwrites a valid one.

- **F-3 (LOW) — logout CSRF.** `app/auth/signout/route.ts` accepts `GET` and performs `signOut()`. An attacker can force a logout via `<img src=".../auth/signout">`. Impact is limited to nuisance sign-out (no data exposure). The code itself flags this: *"CSRF hardening (POST-only + token) is a deferred account-hardening item."* Recommend: make sign-out POST-only (or require a same-site token) before GA.
- **F-4 (INFO) — `next` redirect param.** `signin`/`callback` build `${origin}${next}` from the user-supplied `?next=`. Because everything is prefixed with the **server-derived** `origin`, a `//evil.com` or `https://evil.com` value resolves to a same-origin path (not an open redirect) — so this is **not currently exploitable**. Recommend a belt-and-braces check that `next` starts with a single `/` (and not `//` or `/\`) to keep it robust against future refactors.

---

## Area 2 — RLS (actual Postgres policies vs. app assumptions)

**What I checked:** every `CREATE POLICY` / `ENABLE ROW LEVEL SECURITY` / `GRANT` / `REVOKE` across all 18 migrations; the local/CI auth stub (`supabase/local-dev/000_auth_stub.sql`); `supabase/config.toml`; and the app's data-access split (`lib/db/user-scoped-client.ts` vs `lib/db/client.ts`).

**Findings — the hardened tables are correct; the gap is what was left unhardened.**

**Correct and confirmed:**
- `user_profile`, `saved_search` — RLS **enabled**, owner-scoped for SELECT/INSERT/UPDATE/DELETE via `auth.uid() = id` / `= user_id`, with `GRANT … TO authenticated` (migration `0013_rls_user.sql`). ✅ Matches app assumption.
- `admin_user`, `admin_audit_log` — RLS **enabled + `REVOKE ALL … FROM authenticated, anon`** (migration `0014_admin_rls.sql`, default-deny, no policies). ✅ Matches app assumption (only the service-role pool touches them).
- `weekly_email_send` — RLS enabled + REVOKE ALL (migration `0017`). ✅
- **App-layer RLS plumbing is excellent.** `runWithUserContext` sets `request.jwt.claim.sub` via **parameterized** `set_config(..., is_local=true)` (transaction-scoped, cannot leak to a pooled connection's next borrower). All user-facing CRUD (`account-data.ts`, `saved-search.ts`, `user-profile.ts`) goes through the low-privilege `USER_DATABASE_URL` pool — **never** the service pool — with explicit `WHERE id = $userId` as defense-in-depth *on top of* RLS. `userId` is UUID-validated before it reaches Postgres.

### 🚩 F-1 (HIGH) — RLS/REVOKE hardening was never extended past the user/admin tables

This is the one material finding of the review and it ties Area 2 and Area 3 together.

**The facts, all from the repo itself:**
1. `supabase/config.toml` sets `[api] enabled = true` and `schemas = ["public", "graphql_public"]` — the **entire `public` schema is auto-exposed over both the REST (PostgREST) and GraphQL APIs**.
2. The repo's own `supabase/local-dev/000_auth_stub.sql` documents, and faithfully emulates, real Supabase behaviour:
   > *"Real Supabase grants anon/authenticated broad access to public-schema tables and relies on RLS (+ explicit REVOKEs) as the actual access boundary."*
   and models it as `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;` + `… GRANT SELECT … TO anon;`.
3. Migration `0014_admin_rls.sql` was created **specifically** because this default-grant behaviour meant *"any client holding the anon key could enumerate every admin user and read admin_audit_log … directly via the REST API, bypassing lib/db/admin-guard.ts entirely."*
4. **But only 5 tables were ever hardened.** The other ~18 `public` tables have **no RLS and no REVOKE**: `source`, `activity_series`, `activity_occurrence`, `venue`, `region`, `organisation`, `category`, `tag`, `age_band`, `occurrence_age`, `occurrence_category_tag`, `synonym_alias`, `provenance`, `source_check_run`, **`correction_report`**, **`analytics_event`**, `job_queue`, `app_meta`.

**Consequence (on the default-grant model the repo documents as real):**
- **Integrity / admin-gate bypass (the serious half):** a **signed-in but non-admin `authenticated` user** could `POST`/`PATCH`/`DELETE` directly against `…/rest/v1/source`, `…/activity_occurrence`, `…/activity_series`, `…/venue`, `…/correction_report` — **inserting, editing, or deleting catalog data and resolving corrections without ever passing through `resolveSessionAdmin()` or writing an `admin_audit_log` row.** This defeats the exact authorization boundary Rounds 18–19 built (see Area 3), because the boundary lives in app code while the tables sit open beneath it.
- **Confidentiality / PII (the second half):** `anon` (public anon key) could `GET …/rest/v1/analytics_event` and `…/rest/v1/correction_report` — reading every visitor's `kf_anon_id`, the **raw search-query text** (a parent may type a postal code or a child's name into the box — captured, truncated to 200 chars, by design), and the **correction-report free-text `note`** (the code itself calls this *"arbitrary parent-typed PII"*).

**Exploitability / honest caveats (why this is flagged, not fixed):**
- The account-linked sensitive PII (home postal + child ages in `user_profile`) is **NOT** exposed — that table *is* RLS-protected. The exposure is the anon-keyed usage/feedback tables + the writable catalog tables.
- This app does not ship the anon key to the browser, so the *external* `anon` read requires obtaining the anon key by other means (Supabase treats it as publishable, so this is not a sound control — but it does lower immediate risk). The `authenticated` write bypass requires a signed-in user + the project URL + the anon key.
- **The exposure is contingent on the hosted project's live settings** (REST enabled + default grants). `config.toml` above is the local/linked config and strongly indicates the intended posture, but **the hosted "Exposed schemas" + per-table RLS state should be confirmed in the Supabase dashboard** (30 seconds: Table Editor shows a red *"RLS disabled"* badge per table; Settings → API shows exposed schemas). I did **not** probe the live client Supabase project (would require pulling prod credentials and touching the live system — out of an autonomous review's lane).

**Recommended fix (a real decision — do not merge blind):**
- For **catalog/read-public** tables (`source`, `activity_series`, `activity_occurrence`, `venue`, `region`, taxonomy tables): `ENABLE ROW LEVEL SECURITY` with an explicit **read-only** policy (`FOR SELECT USING (true)`) and **`REVOKE INSERT, UPDATE, DELETE FROM anon, authenticated`** — reads stay public (the product is a public directory), writes are service-role-only.
- For **ops/feedback** tables (`analytics_event`, `correction_report`, `provenance`, `source_check_run`, `job_queue`, `app_meta`): `ENABLE ROW LEVEL SECURITY` + **`REVOKE ALL FROM anon, authenticated`** (default-deny, exactly like `0014`) — they are only ever written by trusted server routes on the service pool, never by the REST surface.
- This should be **one new migration** modelled directly on `0014_admin_rls.sql`, plus a regression test mirroring `tests/rls_admin.test.ts` that asserts `anon`/`authenticated` are denied on these tables. It is scoped, low-risk, and well-precedented in this repo — but it is a **table-by-table access-policy decision** (which tables stay publicly readable) and warrants Jon's / the Architect's sign-off, so it is flagged rather than applied under this review's umbrella.

---

## Area 3 — Admin authz (re-verified from scratch)

**What I checked:** `app/admin/_lib/gate.ts` (`resolveAdminAccess` / `resolveSessionAdmin`), `lib/db/admin-guard.ts` (`requireAdmin`), `lib/admin/access.ts` (interim token), `lib/admin/audit.ts`, all three mutation surfaces (`app/admin/{sources,listings,corrections}/actions.ts` + their `_lib/data.ts`), and a full caller-graph check for every admin write function.

**Findings — the app-layer gate is airtight. Confirmed independently, not just trusted from prior QA.**

- **Reads:** `resolveAdminAccess()` grants on a signed-in active admin **OR** the interim `ADMIN_DASHBOARD_TOKEN`, fail-closed to `notFound()` (404, route existence unadvertised). The token compare is **constant-time with a length-flattening burn** (`lib/admin/access.ts`) and **fails closed when the env var is unset**.
- **Writes:** `resolveSessionAdmin()` is **session-admin-only, never the token** — because `admin_audit_log.admin_user_id` is a `NOT NULL` FK to `admin_user`, so a token caller has no identity to audit and therefore cannot write. Every one of the three server actions (`saveSourceAction`, `createManualListingAction`, `resolveCorrectionAction`) **re-checks `resolveSessionAdmin()` at the top and returns `NEEDS_SESSION_ADMIN` on null** — so a direct `POST` to the server-action endpoint cannot bypass the read gate.
- **Caller graph is clean:** `createSource` / `updateSource` / `createManualListing` / `resolveCorrection` are called **only** from their gated actions; client forms call the *actions*, never the data functions. No ungated path exists.
- **Atomicity + audit:** every mutation runs inside `withAdminTransaction` (service pool `BEGIN`/`COMMIT`/`ROLLBACK`) and writes its `admin_audit_log` row **on the same client**, so the change and its audit trail commit or roll back together. Correct use of the service pool (these are RLS-exempt admin tables + cross-row catalog writes).
- **Production backstop:** with `admin_user` currently empty in prod, `resolveSessionAdmin()` never matches → **all admin mutations are blocked** until a real admin is seeded. Prior QA's live negative check (anon→404, token→read-only, token POST writes nothing) is consistent with this design.

**The only bypass of this model is F-1** — not through the app's code, but by hitting the tables directly via the exposed REST/GraphQL API. The gate is only as strong as the DB grants beneath it; today those grants are open on the very tables the console mutates. **Closing F-1 is what makes this admin authz boundary actually complete.**

---

## Area 4 — PII handling (child ages + home postal codes)

**What I checked:** the schema (`home_postal`, `saved_child_ages` on `user_profile`; `home_geo`), the analytics capture path (`lib/analytics/record.ts`, `types.ts`, `events.ts`, the POST route), the corrections path, the account export/delete/probe routes, the Sentry scrub, and every `console.*` / `Sentry.capture*` call site.

**Findings — application-layer privacy discipline is strong.**

- **The sensitive account PII (postal + child ages) is RLS-protected** (`user_profile`, Area 2) and is **never returned by `/api/me` GET** (that probe returns only `{authenticated, user:{id,email}, profile:{exists,id}}` — no postal, no ages). The `/api/account/export` download is RLS-scoped to the caller and sets `cache-control: no-store`. Deletion requires an explicit `"DELETE"` confirmation phrase (guards a blind/CSRF POST) and runs owner-only via RLS.
- **Analytics deliberately excludes location PII.** `recordSearchPerformed` stores query text (truncated) + filter *tokens* + counts, and **explicitly omits near-me origin coordinates**. Recorders for saved-search / sign-in / corrections store only pseudonymous ids + enums, **never** email, name, or the correction free-text note. Server-only events are rejected by the public analytics route's validator (only 3 low-stakes client events accepted); `user_or_session` is derived **server-side** from the cookie so a caller cannot spoof another visitor.
- **Logging is clean.** Every `console.*` site logs a controlled string / `.message` only (admin-gate, admin-audit, analytics, corrections, worker) — **no token, session, postal, child-age, or full-object logging** anywhere. `app/global-error.tsx`'s `Sentry.captureException` passes through the scrub.
- **Sentry scrub is comprehensive and correctly wired** — `sendDefaultPii: false` + `beforeSend`/`beforeSendTransaction: scrubEvent` on **all three** runtimes (server/edge/client). It strips credential/IP headers + cookies, keeps only a pseudonymous user id, deep-redacts `extra`/`contexts`/`tags`/breadcrumbs/spans/stack-frame vars, and pattern-masks email/IPv4/IPv6/phone.

- **🚩 F-2 (LOW–MED, latent) — the scrub does not cover *this product's* PII.** `DENY_KEYS` has no `postal` / `home_postal` / `postal_code` / `child_ages` / `saved_child_ages` / `dob` / `birthdate`, and `redactString` has no Canadian-postal-code pattern (e.g. `A1A 1A1`). Child ages and home postal are precisely the sensitive fields for a kids' product. **No current code path sends these into a Sentry event** (validation errors return generic messages; bodies aren't attached to `extra`), so this is latent — but it's the one gap in an otherwise-thorough scrub. Recommend (additive, safe): add those keys to `DENY_KEYS` and a `/[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d/i` postal mask to `redactString`, with a matching test. Left unapplied here to keep this branch docs-only and because it touches a reviewed security file + its test suite (a small, deliberate change worth its own reviewed commit).

---

## Area 5 — Secrets (no hardcoded / logged / returned credential)

**What I checked:** a full-tree pattern sweep for secret-shaped literals (JWT/`eyJ`, `sk_live`/`sk_test`, PEM blocks, `ghp_`, AWS/Google keys, inline passwords); `.env.example`; the health route; the two cron-secret routes; the HMAC unsubscribe; and `scripts/` + `.github/workflows/`.

**Findings — clean.**

- **No hardcoded secrets** anywhere in tracked source (grep returned nothing outside the documented local/CI dummy `local_dev_only_not_a_secret`). `.env.example` is placeholders only, with `SUPABASE_SERVICE_ROLE_KEY` correctly annotated *"server-only; NEVER exposed to the client."*
- **No secret is returned by any API.** `GET /api/health` returns only `{status, service, env, commit}`. The weekly-email and retention routes return counts/status only — **email addresses and rendered HTML are stripped** from responses (`sanitize()`), so PII/secrets never land in logs or responses.
- **Shared-secret endpoints fail closed + constant-time.** `POST /api/email/weekly/run` (`WEEKLY_EMAIL_CRON_SECRET`) and `POST /api/analytics/retention/run` (`ANALYTICS_RETENTION_CRON_SECRET`) both **503 when unconfigured** (never open), **401 on mismatch**, via `timingSafeEqual`. The CASL unsubscribe token is HMAC-SHA256, verified with `timingSafeEqual`, and only ever flips `email_opt_in=false` (idempotent, low-risk) — appropriate use of the service pool since the recipient is unauthenticated and the signed token *is* the authorization.
- **CI / scripts handle secrets correctly.** CI's `POSTGRES_PASSWORD: postgres` is an ephemeral throwaway (documented); the e2e setup uses loopback-only Supabase keys (documented *"never production secrets"*); the backfill script explicitly emits *"JSON summary only; no connection strings or secrets."* No `${{ secrets.* }}` misuse.
- **Deploy-tooling vault pattern (spot-check):** the KIDS FUN repo itself contains no deploy-secret material — the vault-slug / ephemeral-fetch pattern lives in the crhq-satellite deploy tooling (push via ephemeral `GIT_ASKPASS`, token never written to disk or printed), which is sound and out of this repo's tree.

- **F-5 (INFO):** `lib/db/pool-config.ts` uses `ssl: { rejectUnauthorized: false }` for non-local hosts. This is the standard Supabase-direct-Postgres pattern (their pooler cert chain), but it technically disables cert validation on the DB connection (theoretical MITM). Not a leak; noted for completeness.

---

## Flagged findings needing a human decision

1. **F-1 (HIGH) — extend RLS/REVOKE hardening to the ~18 unhardened `public` tables.** Requires (a) a 30-second confirmation of the hosted project's exposed-schemas + per-table RLS state in the Supabase dashboard, and (b) a policy decision on which tables stay publicly readable, then one new migration + a regression test. **This is the finding that actually completes the Round 18/19 admin authz boundary.**
2. **F-2 (LOW–MED) — add postal-code + child-age coverage to the Sentry scrub deny-list/patterns.** Additive, low-risk; deferred here to keep the review docs-only.
3. **F-3 (LOW) — make `/auth/signout` POST-only (logout CSRF).** Already an in-code deferred item; confirm it's on the GA hardening list.

## What I did NOT change
Nothing. This review made **zero product-code changes** — it is docs-only (`docs/security-review.md`). No "trivially safe" fix rose to the bar of *fix-and-note*: F-2 touches a reviewed security file + its tests, and F-1/F-3 are explicit judgment calls. All are flagged above for the orchestrator / Jon, per ‹L3›.
