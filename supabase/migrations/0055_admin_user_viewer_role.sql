-- 0055_admin_user_viewer_role.sql — admit 'viewer' to admin_user.role.
--
-- A READ-ONLY, PII-REDACTED admin role for the agent test login (scope:
-- documents/kids-fun/agent-test-admin-login-SCOPE-2026-09-24.md, Option D, staging only). The
-- enforcement ships in the SAME change as this constraint, deliberately:
--   · lib/db/admin-guard.ts canWrite()/canSeePersonalData() — explicit ALLOW-lists of the three
--     human roles; anything else (viewer, or any future/unknown value) gets neither.
--   · app/admin/_lib/gate.ts resolveSessionAdmin() — returns null unless canWrite(role), so all 9
--     admin server actions and POST /api/admin/catalogue-cache/bust refuse a viewer.
--   · the four PII read models null personal columns IN SQL when the caller cannot see them.
--
-- ═══ WHY THE ORDER MATTERS ═══
-- Before this change nothing read admin_user.role: every active row was a full-write, full-PII
-- admin. A 'viewer' row inserted against the OLD code would therefore have been a full admin. This
-- constraint is what makes a 'viewer' row insertable at all, so it can only land together with the
-- code that restricts it. (The CHECK previously REJECTED 'viewer' — the old code could never have
-- seen one.)
--
-- ═══ NO DATA IS TOUCHED ═══
-- One CHECK constraint is widened; no row is inserted, updated or deleted. Human roles
-- (operator / admin / superadmin) are unchanged in the schema and in behaviour.
--
-- ═══ DEPLOY ORDER ═══
-- Either order is safe. Code first: no 'viewer' row can exist yet, so nothing changes. Migration
-- first: the old code would treat a viewer as a full admin — which is why NO viewer row may be
-- seeded anywhere until this code is deployed AND independently verified on that environment.
--
-- ═══ FORWARD BLOCK FOLLOWS 0054's SHAPE ═══
-- Drop every role CHECK by EXPRESSION (0007's is an inline, auto-named constraint), add the
-- superset, then verify exactly one role CHECK remains and that it admits every value.

-- ── forward ──────────────────────────────────────────────────────────────────
DO $$
DECLARE
  con record;
  dropped int := 0;
BEGIN
  FOR con IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE t.relname = 'admin_user'
       AND n.nspname = 'public'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE public.admin_user DROP CONSTRAINT %I', con.conname);
    RAISE NOTICE 'dropped prior role check: %', con.conname;
    dropped := dropped + 1;
  END LOOP;

  IF dropped = 0 THEN
    RAISE NOTICE 'no prior role check found on admin_user — verify this is expected';
  END IF;
END
$$;

ALTER TABLE admin_user
  ADD CONSTRAINT admin_user_role_check
  CHECK (role IN ('operator', 'admin', 'superadmin', 'viewer'));

-- ── the migration checks its own work ────────────────────────────────────────
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = t.relnamespace
   WHERE t.relname = 'admin_user'
     AND ns.nspname = 'public'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%role%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 role CHECK on admin_user, found %', n;
  END IF;

  SELECT count(*) INTO n
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = t.relnamespace
   WHERE t.relname = 'admin_user'
     AND ns.nspname = 'public'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%''viewer''%'
     AND pg_get_constraintdef(c.oid) ILIKE '%''operator''%'
     AND pg_get_constraintdef(c.oid) ILIKE '%''admin''%'
     AND pg_get_constraintdef(c.oid) ILIKE '%''superadmin''%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'role CHECK on admin_user does not admit viewer alongside the three 0007 roles';
  END IF;
END
$$;

-- ── rollback ────────────────────────────────────────────────────────────────
-- Delete any viewer rows FIRST (the narrower CHECK below would reject them, which is the point):
--   DELETE FROM admin_audit_log WHERE admin_user_id IN (SELECT user_id FROM admin_user WHERE role = 'viewer');
--   DELETE FROM admin_user WHERE role = 'viewer';
--   ALTER TABLE admin_user DROP CONSTRAINT admin_user_role_check;
--   ALTER TABLE admin_user ADD CONSTRAINT admin_user_role_check
--     CHECK (role IN ('operator', 'admin', 'superadmin'));
