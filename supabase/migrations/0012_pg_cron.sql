-- 0012_pg_cron.sql — G-T5-3: scheduler trigger (TSD §3A.1, §7.2).
-- pg_cron requires shared_preload_libraries at server start, which only a
-- managed Postgres (Supabase enables it) or a custom-built image provides —
-- a vanilla postgres/postgis container (local dev, CI) cannot load it. This
-- migration best-effort-enables it (works on Supabase, real staging/prod) and
-- is a silent no-op everywhere else, so `migrate.sh` stays green in every
-- environment. The actual "what's due" logic lives in
-- worker/scheduler/tiered.ts (enqueueDueJobs) — portable and DB-testable
-- regardless of which trigger calls it. Once running on Supabase, wire
-- `SELECT cron.schedule(...)` (or a Vercel Cron hitting an API route that
-- calls enqueueDueJobs) to invoke it periodically — tracked as a live-env
-- follow-up, not done here to avoid a migration that only passes on Supabase.

-- ── forward ──────────────────────────────────────────────────────────────────
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron unavailable in this environment (expected outside Supabase) — scheduling triggers from worker/scheduler/tiered.ts via Vercel Cron or the worker''s own interval instead.';
  END;
END $$;

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP EXTENSION IF EXISTS pg_cron;
