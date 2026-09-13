-- 0046_sms_signup_throttle_instant_picks.sql — admit a THIRD scope to the throttle counter.
--
-- ⚠ NOT APPLIED BY THE BUILD THAT SHIPPED IT. Operator action. See §DEPLOY ORDER at the bottom.
--
-- ═══ WHAT THIS CHANGES, AND WHY IT IS THIS SMALL ═══
-- Nothing structural. `sms_signup_throttle` (0045) already holds two kinds of limit in one table,
-- and 0045's own header says why that generalises: "the row shape and the whole decision statement
-- are identical, and only the limits differ — which is a property of the CALLER, not of the
-- storage." The Instant Picks button (lib/sms/instant-picks-throttle.ts) is the third caller and
-- needed exactly one thing the table would not give it: permission to write its own scope value.
-- The CHECK constraint enumerates the allowed scopes, so a new one is a constraint swap and
-- nothing else. No new table, no new column, no backfill, no data touched.
--
-- ═══ WHY A CHECK CONSTRAINT AT ALL, RATHER THAN JUST WIDENING TO `text` ═══
-- Keeping it is what caught this at build time instead of in production. The enumeration is the
-- reason "Instant Picks needs a migration" was a KNOWN cost before anyone wrote the route, rather
-- than a silent `violates check constraint` the first time a parent pressed the button — or, worse,
-- a caller that swallows the error and fails open, which is precisely what this one does
-- (see `degraded` on InstantPicksThrottleResult). A free-text column would have made the throttle
-- silently inert instead of loudly unapplied. It stays enumerated.
--
-- ═══ WHAT 'instant_picks' COUNTS ═══
--   HMAC-SHA256(SMS_PHONE_HASH_SALT, 'sms-instant-picks:' || sms_consent.id)
-- One row per subscriber per UTC day, same shape as the other two. The subject is a HASH of an
-- internal uuid rather than the uuid itself — not because the id is personal data (it is not), but
-- to keep this table join-free: 0045's argument for why the counter is not `sms_send_log` is
-- "different lifetime, different purpose", and a live `sms_consent.id` in a sweepable counter table
-- would hand it a working foreign key into the consent table and make it a subscriber directory.
--
-- ═══ THE RETENTION SWEEP IS STILL NOT SCHEDULED ═══
-- Restated rather than assumed closed, because this migration makes the table grow along a third
-- axis. 0045 flagged that the sweep belongs with worker/core/sms-retention.ts and
-- global_job_schedule (0039) and is NOT written; that is still true, and the `instant_picks` rows
-- are bounded the same way the others are — one row per subject per day, so a caller hammering the
-- button still occupies one row. `idx_sms_signup_throttle_window` already covers the ranged delete
-- when somebody writes it.
--
-- ═══ RLS ═══
-- Unchanged and still default-deny: this alters a constraint on an existing table, so the grants
-- and the `ENABLE ROW LEVEL SECURITY` from 0045 carry over untouched and
-- tests/rls_public_tables.test.ts keeps covering it.
--
-- ═══ DEPLOY ORDER — THIS MIGRATION FIRST, THEN THE CODE. NOT THE OTHER WAY ROUND ═══
-- If the code ships first, every INSERT under the new scope raises `23514 check_violation`,
-- `checkAndRecordInstantPicks` catches it and returns `degraded: true`, and the button works with
-- NO RATE LIMIT AT ALL until this runs. That is survivable — it is a cost control, not a security
-- control, and the route captures the degradation to Sentry on every press so it is loud rather
-- than silent — but it is not the intended state and should not be allowed to persist.
-- Applying this migration BEFORE the code is deployed is safe and has no effect on anything:
-- widening a CHECK cannot invalidate an existing row.

-- ── forward ──────────────────────────────────────────────────────────────────
-- DROP-then-ADD, because Postgres has no "replace this CHECK" verb.
--
-- ⚠ THE DROP FINDS THE CONSTRAINT BY WHAT IT CONSTRAINS, NOT BY WHAT IT IS CALLED — and that is
-- not defensive padding, it is the difference between this migration working and silently not.
-- 0045 declared the rule as an INLINE column check, so its name is whatever Postgres generated
-- (`sms_signup_throttle_scope_check` on a stock server). A plain
-- `DROP CONSTRAINT IF EXISTS sms_signup_throttle_scope_check` would MISS a differently-named one —
-- and `IF EXISTS` makes that miss silent. The ADD below would then succeed, leaving TWO checks on
-- the column: the new permissive one AND the old restrictive one. Both must pass, so every
-- `instant_picks` write would still be rejected, by a constraint this migration believed it had
-- removed. The throttle would fail open (it catches the error) and the button would run unlimited,
-- with a migration ledger saying the fix was applied.
--
-- So: enumerate the table's CHECK constraints, drop every one whose expression mentions `scope`,
-- then add ours. `pg_get_constraintdef` is the authority on what a constraint actually says.
DO $$
DECLARE
  con record;
BEGIN
  FOR con IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE t.relname = 'sms_signup_throttle'
       AND n.nspname = 'public'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%scope%'
  LOOP
    EXECUTE format('ALTER TABLE public.sms_signup_throttle DROP CONSTRAINT %I', con.conname);
    RAISE NOTICE 'dropped prior scope check: %', con.conname;
  END LOOP;
END
$$;

ALTER TABLE sms_signup_throttle
  ADD CONSTRAINT sms_signup_throttle_scope_check
  CHECK (scope IN ('phone', 'ip', 'instant_picks'));

COMMENT ON COLUMN sms_signup_throttle.scope IS
  'phone = protects one handset from repeated confirmation texts. ip = defence in depth against '
  'one caller spraying MANY different numbers. The IP half derives from a client-influenced '
  'forwarded-for header and is never the only thing between an attacker and somebody''s phone. '
  'instant_picks = caps one subscriber''s presses of the Instant Picks button on the preferences '
  'page. Unlike the other two, that one is a COST CONTROL rather than a protection: the button '
  'reaches nobody but the presser, and whoever holds the preferences link can press it.';

-- ── rollback ────────────────────────────────────────────────────────────────
-- ⚠ NOT A PURE INVERSE, AND THE ORDER MATTERS. Narrowing the CHECK will FAIL while any
-- 'instant_picks' row is still present, so the delete has to come first. Those rows are
-- throttle counters and nothing else — deleting them costs at most one subscriber one extra
-- press, which is the whole reason this is safe to reverse at all.
--
--   DELETE FROM sms_signup_throttle WHERE scope = 'instant_picks';
--   ALTER TABLE sms_signup_throttle DROP CONSTRAINT sms_signup_throttle_scope_check;
--   ALTER TABLE sms_signup_throttle
--     ADD CONSTRAINT sms_signup_throttle_scope_check CHECK (scope IN ('phone', 'ip'));
-- (The name IS known on the way back — this migration's ADD is what set it.)
