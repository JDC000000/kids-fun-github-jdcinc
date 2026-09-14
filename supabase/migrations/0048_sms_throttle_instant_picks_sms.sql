-- 0048_sms_throttle_instant_picks_sms.sql — admit the two SEND-PATH scopes to the throttle counter.
--
-- Instant Picks plan v2.0 §4.2, task 2. Companion to lib/sms/instant-picks-send-throttle.ts.
--
-- ═══ WHY TWO MORE SCOPES RATHER THAN RETUNING `instant_picks` ═══
-- `instant_picks` counts a PAGE RENDER: 1/min, 20/day, fail-open, "a press costs one subscriber's
-- own CPU and reaches nobody else". That sentence is still true of the page path and it is what
-- justifies those numbers. It is NOT true of a path that dispatches a real SMS: that one spends
-- money and reaches a handset, and the preferences link — which is the credential — travels in a
-- URL, so whoever holds a link can make us pay to text that handset (plan §4.1).
--
-- Two paths with different stakes therefore get two counters, not one retuned counter. Retuning
-- `instant_picks` downward would have punished a parent re-rolling an on-page list for a risk that
-- belongs to a different action; leaving the send path on `instant_picks` would have authorised
-- twenty texts per subscriber per day against a disclosed cadence of one a week.
--
--   instant_picks_sms     HMAC-SHA256(SMS_PHONE_HASH_SALT, 'sms-instant-picks-send:' || sms_consent.id)
--                         600s between sends, 3 per UTC day. Per subscriber.
--   instant_picks_sms_ip  HMAC-SHA256(SMS_PHONE_HASH_SALT, 'sms-instant-picks-send-ip:' || ip)
--                         30s between sends, 20 per UTC day. Per source IP.
--
-- ═══ THE NUMBERS ARE NOT NEW NUMBERS ═══
-- They are `SIGNUP_THROTTLE_LIMITS` verbatim — the limits this repo already defends for the OTHER
-- user action that causes a real text (the signup confirmation SMS). Reusing them means there is
-- no new number to argue about and the two send paths cannot drift apart;
-- tests/sms/instant_picks_send_throttle.test.ts asserts the equality mechanically.
--
-- ═══ WHY THE IP HALF IS NOT OPTIONAL HERE, HAVING BEEN CORRECTLY OMITTED FOR THE PAGE PATH ═══
-- 0046 and lib/sms/instant-picks-throttle.ts both argue, correctly, that a page press has no IP
-- half because the victim and the caller are the same person. A send path makes the victim someone
-- ELSE — a third party's handset, our bill, and carrier complaints against a toll-free number whose
-- reputation is the product. That is the exact threat model 0045 built the 'ip' scope for, so the
-- same answer applies rather than a new one.
--
-- ═══ RLS / RETENTION / TABLE SHAPE ═══
-- All unchanged. This alters ONE check constraint on an existing table: 0045's grants and
-- `ENABLE ROW LEVEL SECURITY` carry over untouched (tests/rls_public_tables.test.ts keeps covering
-- it), no new column, no backfill, no data touched. The retention sweep 0045 and 0046 both flagged
-- as unwritten is still unwritten; these rows are bounded the same way — one row per subject per
-- UTC day — and `idx_sms_signup_throttle_window` already covers the ranged delete when someone
-- writes it.
--
-- ═══ ⚠ DEPLOY ORDER — THIS MIGRATION FIRST, THEN THE CODE, AND HERE IT ACTUALLY BITES ═══
-- 0046 could say "survivable" about being applied late, because the page throttle FAILS OPEN: an
-- unapplied constraint meant an unlimited button and a Sentry event. The send throttle FAILS
-- CLOSED (plan §4.3), so if the code ships first, every INSERT under the new scopes raises
-- `23514 check_violation`, the throttle refuses, and NO on-demand text is ever sent. That is the
-- safe direction — it costs a feature, not money — but it is a silent feature outage rather than a
-- survivable degradation, so apply this first.
--
-- ═══ ⚠ WHAT THE LIVE PRODUCTION CONSTRAINT ACTUALLY SAYS — CHECK, DO NOT ASSUME ═══
-- `public.schema_migrations` in production stops at 0045, but 0046 IS applied there: it was run
-- out-of-band by an Operator, so the ledger understates the live schema (confirmed via
-- pg_constraint, 2026-09-14). The forward block below therefore does NOT depend on which of the
-- two states the target database is in — it reads the constraint that is actually there, drops it
-- by expression, and installs a superset. Widening a CHECK cannot invalidate an existing row, so
-- it is safe from either starting point. To see the live state for yourself, read-only:
--
--   SELECT conname, pg_get_constraintdef(c.oid)
--     FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
--     JOIN pg_namespace n ON n.oid = t.relnamespace
--    WHERE n.nspname = 'public' AND t.relname = 'sms_signup_throttle' AND c.contype = 'c';

-- ── forward ──────────────────────────────────────────────────────────────────
-- DROP-then-ADD by EXPRESSION, not by name — 0046's pattern, verbatim, for 0046's reason.
--
-- 0045 declared the rule as an INLINE column check, so its name is whatever Postgres generated. A
-- `DROP CONSTRAINT IF EXISTS sms_signup_throttle_scope_check` would MISS a differently-named one,
-- and `IF EXISTS` makes that miss SILENT. The ADD below would then succeed and leave TWO checks on
-- the column — the new permissive one and the old restrictive one. Both must pass, so every write
-- under a new scope would still be rejected, by a constraint this migration believed it had
-- removed. `pg_get_constraintdef` is the authority on what a constraint actually says.
--
-- NOTE FOR WHOEVER READS THIS AFTER 0046: on a database where 0046 ran, the name IS known
-- (0046's ADD set it). The expression form is kept anyway because it is correct on BOTH the
-- 0046-applied and 0046-unapplied databases this repo currently has to work against, and because a
-- migration that is right for one ledger state and silently wrong for the other is the failure
-- this pattern exists to prevent.
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

  -- Zero is not an error — a database could conceivably have lost the check — but it IS worth
  -- saying out loud, because the likeliest cause is that this loop's predicate stopped matching
  -- and the ADD below is about to sit beside a constraint nobody dropped.
  IF dropped = 0 THEN
    RAISE NOTICE 'no prior scope check found on sms_signup_throttle — verify this is expected';
  END IF;
END
$$;

ALTER TABLE sms_signup_throttle
  ADD CONSTRAINT sms_signup_throttle_scope_check
  CHECK (scope IN ('phone', 'ip', 'instant_picks', 'instant_picks_sms', 'instant_picks_sms_ip'));

-- ── the migration checks its own work ────────────────────────────────────────
-- Exactly ONE scope check must remain, and it must admit the two new values. Without this, the
-- "two constraints, both must pass" failure the DROP block above describes would still be silent
-- here — the ADD succeeds either way. Cheap, and it converts an invisible half-application into a
-- failed migration.
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
     AND pg_get_constraintdef(c.oid) ILIKE '%instant_picks_sms_ip%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'scope CHECK on sms_signup_throttle does not admit instant_picks_sms_ip';
  END IF;
END
$$;

COMMENT ON COLUMN sms_signup_throttle.scope IS
  'phone = protects one handset from repeated confirmation texts. ip = defence in depth against '
  'one caller spraying MANY different numbers. The IP half derives from a client-influenced '
  'forwarded-for header and is never the only thing between an attacker and somebody''s phone. '
  'instant_picks = caps one subscriber''s presses of the Instant Picks button on the preferences '
  'page. Unlike the other two, that one is a COST CONTROL rather than a protection: the button '
  'reaches nobody but the presser, and whoever holds the preferences link can press it. '
  'instant_picks_sms / instant_picks_sms_ip = cap the SMS that press can now dispatch. Those two '
  'ARE protections, not cost controls, and they are why instant_picks was not simply retuned: a '
  'send reaches a handset and spends money, so the per-subscriber counter is no longer the whole '
  'limit. Same numbers as phone/ip, because it is the same threat.';

-- ── rollback ────────────────────────────────────────────────────────────────
-- ⚠ NOT A PURE INVERSE, AND THE ORDER MATTERS, exactly as in 0046: narrowing the CHECK FAILS while
-- any row under a removed scope is still present, so the delete comes first. Those rows are
-- throttle counters and nothing else — deleting them costs at most one subscriber one extra send,
-- which is the whole reason this is safe to reverse.
--
--   DELETE FROM sms_signup_throttle WHERE scope IN ('instant_picks_sms', 'instant_picks_sms_ip');
--   ALTER TABLE sms_signup_throttle DROP CONSTRAINT sms_signup_throttle_scope_check;
--   ALTER TABLE sms_signup_throttle
--     ADD CONSTRAINT sms_signup_throttle_scope_check
--     CHECK (scope IN ('phone', 'ip', 'instant_picks'));
-- (The name IS known on the way back — this migration's ADD is what set it.)
