-- 000_auth_stub.sql — LOCAL/CI ONLY. Do NOT apply to a real Supabase project.
--
-- Emulates the slice of Supabase's `auth` schema that RLS policies
-- (0013_rls_user.sql, G-T6-3) and lib/db/auth.ts depend on — auth.uid(),
-- an `auth.users` table, and login-capable `authenticated`/`anon` roles —
-- so migrations and RLS can be exercised against a bare Postgres (local
-- docker, CI) without a real Supabase project, which already provides all
-- of this natively.
--
-- This file lives OUTSIDE supabase/migrations/ specifically so
-- scripts/migrate.sh never applies it anywhere, including a real Supabase
-- database. Local dev / CI only run it via scripts/local-db-bootstrap.sh,
-- BEFORE migrate.sh. The dummy password below has no value outside an
-- ephemeral local/CI container — never used against any real environment.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated LOGIN PASSWORD 'local_dev_only_not_a_secret' NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO authenticated, anon;

-- Mirror real Supabase, which grants the API roles USAGE on the `auth` schema so
-- they can resolve auth.uid()/auth.role() themselves. Without this, `authenticated`
-- can only reach auth.uid() indirectly (inside an owner-defined RLS policy, which
-- runs with the table owner's rights); a direct `SELECT auth.uid()` fails with
-- "permission denied for schema auth". EXECUTE on the function is already PUBLIC
-- by default; the USAGE grant is what was missing.
GRANT USAGE ON SCHEMA auth TO authenticated, anon;

-- Model Supabase's DEFAULT table privileges for the API roles. Real Supabase
-- grants anon/authenticated broad access to public-schema tables and relies on
-- RLS (+ explicit REVOKEs) as the actual access boundary — which is exactly the
-- footgun 0014_admin_rls.sql defends against. A bare Postgres grants the API
-- roles NO table access, so before this, admin_user/admin_audit_log "denied" for
-- the WRONG reason (missing grant, not RLS/REVOKE): the same permission-denied
-- error occurred with OR without 0014, so tests/rls_admin.test.ts (Layer 1)
-- could not tell a fixed schema from an unfixed one. With these grants, the API
-- roles CAN read ordinary public tables (e.g. region) and are blocked from the
-- admin tables specifically by 0014 — the distinction the regression test needs.
--
-- ALTER DEFAULT PRIVILEGES (deliberately NOT `GRANT ON ALL TABLES`) is what makes
-- this faithful AND safe: it applies to tables the owner creates LATER via
-- migrate.sh, so 0007 grants the roles access at create-time and 0014 REVOKEs it
-- back — the real production sequence. A blanket GRANT ON ALL TABLES would
-- instead re-grant admin_user/admin_audit_log on any stub re-apply, silently
-- undoing 0014. This requires the stub to run BEFORE migrations (it does — see
-- scripts/local-db-bootstrap.sh).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO authenticated, anon;
