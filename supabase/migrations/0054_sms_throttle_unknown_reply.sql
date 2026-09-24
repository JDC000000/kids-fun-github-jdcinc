-- 0054_sms_throttle_unknown_reply.sql — admit 'unknown_reply' to the throttle counter.
--
-- Companion to lib/sms/inbound-reply-guard.ts. 2026-09-24 incident: POST /api/sms/inbound answers
-- any unrecognised text with "Sorry, we didn't catch that…", with no per-sender limit. Two of our
-- own numbers ping-ponged ~60 texts in 39s; the same mechanism works against any parent's phone
-- with an auto-responder. The fix caps that reply at one per sender per UTC day:
--
--   unknown_reply   HMAC-SHA256(SMS_PHONE_HASH_SALT, 'sms-unknown-reply:' || digits(From))
--                   1 per UTC day, no minimum interval. Per SENDER (no sms_consent row needed —
--                   a stranger texting us has none, which is exactly why this is keyed on a hash
--                   of the number rather than a subscriber id).
--
-- ═══ RLS / RETENTION / TABLE SHAPE ═══
-- Unchanged. Alters ONE check constraint on an existing table, exactly as 0046 and 0048 did: no
-- new column, no backfill, no data touched. Rows are bounded one per sender per UTC day.
--
-- ═══ DEPLOY ORDER — EITHER ORDER IS SAFE, MIGRATION FIRST IS BETTER ═══
-- The guard FAILS CLOSED. If the code ships first, every INSERT under 'unknown_reply' raises
-- 23514 check_violation, the guard refuses, and the unknown-keyword reply is silent (plus one
-- Sentry event per inbound unknown text) until this runs. Silence is the safe direction here.
--
-- ═══ FORWARD BLOCK IS 0048's, VERBATIM IN SHAPE ═══
-- Drop every scope CHECK by EXPRESSION (0045's was an inline, auto-named constraint, and the
-- production ledger has understated the live schema before — see 0048's header), add the superset,
-- then verify exactly one scope CHECK remains and that it admits the new value.

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
     WHERE t.relname = 'sms_signup_throttle'
       AND n.nspname = 'public'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%scope%'
  LOOP
    EXECUTE format('ALTER TABLE public.sms_signup_throttle DROP CONSTRAINT %I', con.conname);
    RAISE NOTICE 'dropped prior scope check: %', con.conname;
    dropped := dropped + 1;
  END LOOP;

  IF dropped = 0 THEN
    RAISE NOTICE 'no prior scope check found on sms_signup_throttle — verify this is expected';
  END IF;
END
$$;

ALTER TABLE sms_signup_throttle
  ADD CONSTRAINT sms_signup_throttle_scope_check
  CHECK (scope IN ('phone', 'ip', 'instant_picks', 'instant_picks_sms', 'instant_picks_sms_ip',
                   'unknown_reply'));

-- ── the migration checks its own work ────────────────────────────────────────
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = t.relnamespace
   WHERE t.relname = 'sms_signup_throttle'
     AND ns.nspname = 'public'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%scope%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 scope CHECK on sms_signup_throttle, found %', n;
  END IF;

  SELECT count(*) INTO n
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = t.relnamespace
   WHERE t.relname = 'sms_signup_throttle'
     AND ns.nspname = 'public'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%unknown_reply%'
     AND pg_get_constraintdef(c.oid) ILIKE '%instant_picks_sms_ip%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'scope CHECK on sms_signup_throttle does not admit unknown_reply alongside the 0048 scopes';
  END IF;
END
$$;

COMMENT ON COLUMN sms_signup_throttle.scope IS
  'phone = protects one handset from repeated confirmation texts. ip = defence in depth against '
  'one caller spraying MANY different numbers. The IP half derives from a client-influenced '
  'forwarded-for header and is never the only thing between an attacker and somebody''s phone. '
  'instant_picks = caps one subscriber''s presses of the Instant Picks button on the preferences '
  'page (a cost control). instant_picks_sms / instant_picks_sms_ip = cap the SMS that press can '
  'dispatch (a protection). unknown_reply = caps the inbound webhook''s "didn''t catch that" '
  'auto-reply at one per sender per UTC day, so an auto-responder on the other end cannot hold us '
  'in a reply loop (2026-09-24 incident).';

-- ── rollback ────────────────────────────────────────────────────────────────
-- Delete first: narrowing the CHECK fails while any 'unknown_reply' row exists. Those rows are
-- throttle counters only. ⚠ Rolling back WITHOUT reverting the code leaves the unknown-keyword
-- reply silent (fail-closed), which is safe.
--
--   DELETE FROM sms_signup_throttle WHERE scope = 'unknown_reply';
--   ALTER TABLE sms_signup_throttle DROP CONSTRAINT sms_signup_throttle_scope_check;
--   ALTER TABLE sms_signup_throttle
--     ADD CONSTRAINT sms_signup_throttle_scope_check
--     CHECK (scope IN ('phone', 'ip', 'instant_picks', 'instant_picks_sms', 'instant_picks_sms_ip'));
