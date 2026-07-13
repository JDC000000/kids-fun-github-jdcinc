-- 0014_admin_rls.sql — CRITICAL fix: RLS on admin_user + admin_audit_log
-- (default-deny, no policies). Found by independent code review of
-- overnight/backend-foundation (documents/execution/kids-fun-backend-
-- foundation-code-review-2026-07-13.md, CRITICAL #3) and applies equally to
-- this branch: 0007_user_admin.sql creates admin_user/admin_audit_log but
-- 0013_rls_user.sql only covers user_profile/saved_search. Live-verified
-- there: on a real Supabase project, `anon`/`authenticated` get default
-- table grants on public-schema tables unless explicitly revoked — without
-- RLS, any client holding the anon key could enumerate every admin user and
-- read admin_audit_log's before/after JSON directly via the REST API,
-- bypassing lib/db/admin-guard.ts entirely (that guard only gates the app's
-- own server code, not direct table access).
--
-- Default-deny is intentional: no policies are created. These tables are
-- only ever meant to be touched via a service-role client (bypasses RLS by
-- design), never via the anon/authenticated REST surface.

-- ── forward ──────────────────────────────────────────────────────────────────
ALTER TABLE admin_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON admin_user FROM authenticated, anon;
REVOKE ALL ON admin_audit_log FROM authenticated, anon;

-- ── rollback ────────────────────────────────────────────────────────────────
--   ALTER TABLE admin_audit_log DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE admin_user DISABLE ROW LEVEL SECURITY;
