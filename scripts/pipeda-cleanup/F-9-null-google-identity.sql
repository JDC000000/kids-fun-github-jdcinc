-- ============================================================================
-- F-9 (PIPEDA / Round 25 Task WW) — clear the redundant google_identity email
--                                    copy on EXISTING rows
-- ============================================================================
-- STATUS: REVIEWABLE ARTIFACT — **AWAITING SIGN-OFF, NOT APPLIED**.
--
-- This script is DELIBERATELY NOT part of the forward-migration sequence
-- (supabase/migrations/*.sql). scripts/migrate.sh and scripts/seed.sh only glob
-- supabase/migrations and supabase/seeds respectively, so nothing here runs
-- automatically in CI or on deploy. It is applied MANUALLY, once, and only after
-- explicit human sign-off — same discipline as the Round 20 RLS lockdown.
--
-- WHAT IT DOES
--   Sets user_profile.google_identity to NULL for any row that still carries it.
--   The code change in this same task already STOPPED new writes (ensureUserProfile
--   no longer inserts google_identity) and the data export now resolves the user's
--   email on-demand from auth.users via resolveRecipientEmail() instead of reading
--   this column. This optional follow-up scrubs the pre-existing redundant copies.
--
-- LOW RISK — this is a pure redundant copy: the same email already lives safely in
--   the Supabase-managed auth.users row, and every consumer (weekly digest + the
--   data export) already resolves it live from there. Nulling this column loses NO
--   information that is not still available from auth.users.
--
-- SCOPE — this touches EXACTLY ONE column and NOTHING else:
--   * only user_profile.google_identity is written
--   * no schema change (the column stays; it is cleared, not dropped)
--   * no other table, column, or row attribute is read for writing
--
-- IDEMPOTENT: the WHERE clause matches only rows where the column is still set, so
--   a second run updates 0 rows. Safe to re-run.
--
-- HOW TO RUN (only after sign-off), against the target DB:
--   DATABASE_URL=postgres://…  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f scripts/pipeda-cleanup/F-9-null-google-identity.sql
-- ============================================================================

BEGIN;

-- BEFORE — how many rows still carry the redundant copy (informational, read-only).
SELECT count(*) AS rows_with_google_identity_before
  FROM user_profile
 WHERE google_identity IS NOT NULL;

-- The clear. Scoped to ONE column; idempotent (re-run affects 0 rows).
UPDATE user_profile
   SET google_identity = NULL
 WHERE google_identity IS NOT NULL;

-- AFTER — must be 0 once applied.
SELECT count(*) AS rows_with_google_identity_after
  FROM user_profile
 WHERE google_identity IS NOT NULL;

COMMIT;
