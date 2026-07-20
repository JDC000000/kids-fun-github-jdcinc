-- ============================================================================
-- F-8 (PIPEDA / Round 25 Task WW) — clear stored children's ages on EXISTING rows
-- ============================================================================
-- STATUS: REVIEWABLE ARTIFACT — **AWAITING SIGN-OFF, NOT APPLIED**.
--
-- This script is DELIBERATELY NOT part of the forward-migration sequence
-- (supabase/migrations/*.sql). scripts/migrate.sh and scripts/seed.sh only glob
-- supabase/migrations and supabase/seeds respectively, so nothing here runs
-- automatically in CI or on deploy. It is applied MANUALLY, once, and only after
-- explicit human sign-off — exactly the same discipline used for the Round 20 RLS
-- lockdown (built as Task HH, applied to staging only after separate authorization).
--
-- WHAT IT DOES
--   Resets user_profile.saved_child_ages back to its schema default (empty array)
--   for any row that still carries a collected value. The code change in this same
--   task already STOPPED new collection (the account form input + the writable
--   field were removed); this optional follow-up scrubs values collected BEFORE
--   that change from live rows.
--
-- SCOPE — this touches EXACTLY ONE column and NOTHING else:
--   * only user_profile.saved_child_ages is written
--   * no schema change (the column stays; it is reset, not dropped)
--   * no other table, column, or row attribute is read for writing
--
-- IDEMPOTENT: the WHERE clause matches only rows that still hold a value, so a
--   second run updates 0 rows. Safe to re-run.
--
-- NOTE (column is NOT NULL): saved_child_ages is `integer[] NOT NULL DEFAULT '{}'`
--   (supabase/migrations/0007_user_admin.sql). "NULL-out" therefore means reset to
--   the empty-array default '{}', not literal SQL NULL (which the constraint forbids).
--
-- REVERSIBILITY: this is a genuine data clear — once applied, the previously
--   collected ages are gone and cannot be recovered from this table. That is the
--   intended PIPEDA outcome. Take a backup/snapshot first if a rollback window is
--   required by policy.
--
-- HOW TO RUN (only after sign-off), against the target DB:
--   DATABASE_URL=postgres://…  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f scripts/pipeda-cleanup/F-8-null-saved-child-ages.sql
-- ============================================================================

BEGIN;

-- BEFORE — how many rows still carry a collected value (informational, read-only).
SELECT count(*) AS rows_with_child_ages_before
  FROM user_profile
 WHERE saved_child_ages IS DISTINCT FROM '{}'::integer[];

-- The clear. Scoped to ONE column; idempotent (re-run affects 0 rows).
UPDATE user_profile
   SET saved_child_ages = '{}'::integer[]
 WHERE saved_child_ages IS DISTINCT FROM '{}'::integer[];

-- AFTER — must be 0 once applied.
SELECT count(*) AS rows_with_child_ages_after
  FROM user_profile
 WHERE saved_child_ages IS DISTINCT FROM '{}'::integer[];

COMMIT;
