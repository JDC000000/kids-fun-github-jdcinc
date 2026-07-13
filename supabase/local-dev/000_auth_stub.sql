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
