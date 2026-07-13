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


-- Model Supabase's DEFAULT table privileges for the API roles. Real Supabase
-- grants anon/authenticated broad access to public-schema tables and relies on
-- RLS (+ explicit REVOKEs) as the actual access boundary. Bare Postgres grants
-- the API roles NO table access, which can make security tests pass for the
-- wrong reason: a generic missing-grant denial instead of the intended RLS or
-- explicit admin-table REVOKE.
--
-- ALTER DEFAULT PRIVILEGES (deliberately NOT `GRANT ON ALL TABLES`) applies only
-- to tables the owner creates later via migrate.sh. That lets earlier migrations
-- grant ordinary table access at create-time and lets 0014_admin_rls.sql revoke
-- admin_user/admin_audit_log back afterward. A blanket GRANT ON ALL TABLES here
-- would re-grant admin tables if the stub were ever re-applied after 0014.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO authenticated, anon;
