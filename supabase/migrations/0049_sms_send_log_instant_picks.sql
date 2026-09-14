-- 0049_sms_send_log_instant_picks.sql — admit 'instant_picks' as an `sms_send_log.send_type`.
--
-- Instant Picks plan v2.0 §3.4, task 6. Companion to lib/sms/instant-picks-send.ts.
--
-- ═══ WHAT THIS IS FOR ═══
-- An on-demand digest is a Commercial Electronic Message, so CASL requires an append-only record
-- that it went out (PRD §1.4). `sms_send_log` is that record, and it already carries four other
-- message types; this is the fifth. One row per dispatched on-demand text, `picks_snapshot` NULL.
--
-- ═══ 🔴 THE TWO THINGS THIS MIGRATION MUST NOT DO, AND THE MECHANISM FOR EACH ═══
--
-- 1. IT MUST NOT WIDEN `sms_send_log_picks_only_weekly`, AND THE DROP BELOW IS WHERE THAT WOULD
--    HAPPEN BY ACCIDENT.
--    0035 declared its send_type check INLINE, so the name is server-generated and this migration
--    has to find it by expression (see §2). But `sms_send_log` has TWO check constraints whose
--    definition mentions `send_type`:
--
--      sms_send_log_send_type_check   CHECK (send_type = ANY (ARRAY['confirm_request', ...]))
--      sms_send_log_picks_only_weekly CHECK (picks_snapshot IS NULL OR send_type = 'weekly')
--
--    A DROP loop matching `ILIKE '%send_type%'` — the obvious transliteration of 0046's pattern —
--    WOULD DROP BOTH, and the ADD below only puts one back. The second one would be gone, silently,
--    with every test still green.
--
--    Why that matters, spelled out because it is invisible from here: the weekly novelty filter in
--    lib/sms/weekly-send-io.ts queries `send_type = 'weekly' AND picks_snapshot IS NOT NULL` and
--    its own comment calls those "the same condition twice" — TRUE ONLY BECAUSE THIS CONSTRAINT
--    HOLDS. Lose it, let an on-demand row carry a snapshot, and a Wednesday button press would
--    suppress those activities from Friday's real text. The click-through hub attribution
--    (lib/sms/click-through.ts:344) rests on the same invariant.
--
--    So the predicate below is narrowed on three axes — it must mention `send_type`, it must
--    mention `confirm_request` (which only the enumeration does), and it must NOT mention
--    `picks_snapshot` — and the post-check at the bottom fails the migration if
--    `sms_send_log_picks_only_weekly` is not still present and still saying exactly what it said.
--
-- 2. IT MUST NOT ADD 'instant_picks' TO `findLastWeek`'s IN-LIST. That is code, not schema, so
--    nothing here can do it — but it is recorded here because this migration is what makes it
--    POSSIBLE. `findLastWeek` (lib/sms/preferences.ts) filters
--    `send_type IN ('weekly','empty_week','pause_notice')` to build the "Last Friday" panel, and
--    the Instant Picks button sits INSIDE that panel. An on-demand row reaching it would show a
--    parent their own button press as though it were a text we had decided to send them, and would
--    land in PRD §6's send metrics as a different kind of message than it is. The three-value
--    IN-list IS the discrimination that lets this table hold both kinds of row.
--    tests/sms/instant_picks_send_log_invariants.test.ts asserts both of these statically.
--
-- ═══ WHY 'instant_picks' AND NOT 'instant_picks_sms' ═══
-- The throttle scopes need the `_sms` suffix because a NON-sending `instant_picks` scope already
-- exists beside them and the two must not be confused. Nothing in this column is ever written for
-- a page render — `sms_send_log` records messages that were SENT, by definition — so there is no
-- second meaning here to disambiguate from, and the shorter value is the one that reads correctly
-- in an audit export.
--
-- ═══ OUTCOME VALUES, RLS, RETENTION ═══
-- Unchanged. An on-demand row uses the existing `outcome` vocabulary ('sent' / 'failed' /
-- 'stopped_via_carrier'), so the outcome CHECK is untouched. This alters one constraint on an
-- existing table: 0035's indexes, grants and RLS carry over, and the row is retained indefinitely
-- as CASL evidence like every other row in this table.
--
-- ═══ DEPLOY ORDER — THIS MIGRATION BEFORE THE CODE ═══
-- If the code ships first, the INSERT raises `23514 check_violation`. lib/sms/instant-picks-send.ts
-- swallows a log failure (the text has already gone; losing the audit row must not 500 a parent's
-- page), so the visible symptom would be a texted parent with NO audit row — the one failure mode
-- a CASL record exists to prevent. Apply this first. Widening a CHECK cannot invalidate an
-- existing row, so applying it early is free.

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
     WHERE t.relname = 'sms_send_log'
       AND n.nspname = 'public'
       AND c.contype = 'c'
       -- The enumeration, and ONLY the enumeration. See §1 of the header: `picks_only_weekly` also
       -- mentions send_type, and dropping it here would be the defect this whole feature was
       -- warned about.
       AND pg_get_constraintdef(c.oid) ILIKE '%send_type%'
       AND pg_get_constraintdef(c.oid) ILIKE '%confirm_request%'
       AND pg_get_constraintdef(c.oid) NOT ILIKE '%picks_snapshot%'
  LOOP
    EXECUTE format('ALTER TABLE public.sms_send_log DROP CONSTRAINT %I', con.conname);
    RAISE NOTICE 'dropped prior send_type enumeration: %', con.conname;
    dropped := dropped + 1;
  END LOOP;

  IF dropped = 0 THEN
    RAISE NOTICE 'no prior send_type enumeration found on sms_send_log — verify this is expected';
  END IF;
END
$$;

ALTER TABLE sms_send_log
  ADD CONSTRAINT sms_send_log_send_type_check
  CHECK (send_type IN ('confirm_request', 'welcome', 'weekly',
                       'empty_week', 'pause_notice', 'instant_picks'));

-- ── the migration checks its own work, and the thing it checks hardest is what it did NOT do ──
DO $$
DECLARE
  n int;
  def text;
BEGIN
  -- (a) The snapshot rule is still there, and still says exactly what it said. Checked by
  --     EXPRESSION as well as by name: a constraint that was dropped and re-added more permissively
  --     would still answer to the name.
  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = t.relnamespace
   WHERE t.relname = 'sms_send_log'
     AND ns.nspname = 'public'
     AND c.contype = 'c'
     AND c.conname = 'sms_send_log_picks_only_weekly';
  IF def IS NULL THEN
    RAISE EXCEPTION
      'sms_send_log_picks_only_weekly is GONE after this migration. It is the constraint the '
      'weekly novelty filter''s "same condition twice" assumption rests on. Do not proceed.';
  END IF;
  IF def NOT ILIKE '%picks_snapshot%' OR def NOT ILIKE '%weekly%' THEN
    RAISE EXCEPTION 'sms_send_log_picks_only_weekly no longer constrains picks_snapshot to weekly: %', def;
  END IF;

  -- (b) Exactly one send_type ENUMERATION, and it admits the new value. Two would mean the drop
  --     missed one and every 'instant_picks' insert would fail against a constraint this
  --     migration believed it had replaced.
  SELECT count(*) INTO n
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = t.relnamespace
   WHERE t.relname = 'sms_send_log'
     AND ns.nspname = 'public'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%confirm_request%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 send_type enumeration on sms_send_log, found %', n;
  END IF;

  SELECT count(*) INTO n
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = t.relnamespace
   WHERE t.relname = 'sms_send_log'
     AND ns.nspname = 'public'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%instant_picks%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'send_type enumeration on sms_send_log does not admit instant_picks';
  END IF;
END
$$;

COMMENT ON COLUMN sms_send_log.send_type IS
  'Which message this row records. confirm_request / welcome / weekly / empty_week / pause_notice '
  'are sends WE decided to make. instant_picks is the one a SUBSCRIBER asked for, by pressing the '
  'button on their own preferences page — a solicited message, and the distinction the compliance '
  'position rests on. ⚠ instant_picks rows are deliberately NOT in findLastWeek''s IN-list '
  '(lib/sms/preferences.ts): the "Last Friday" panel shows what we sent on our own initiative, and '
  'the Instant Picks button sits inside that panel. ⚠ instant_picks rows carry picks_snapshot NULL '
  'and sms_send_log_picks_only_weekly must keep enforcing that — the weekly novelty filter treats '
  '"send_type = weekly" and "picks_snapshot IS NOT NULL" as the same condition.';

-- ── rollback ────────────────────────────────────────────────────────────────
-- ⚠ ORDER MATTERS, and unlike the throttle counter THESE ROWS ARE CASL EVIDENCE — deleting them to
-- satisfy a narrowed constraint destroys the record that a message was sent to a real person.
-- Do not do it casually; prefer leaving the wider constraint in place.
--
--   -- only if you genuinely accept losing the audit rows:
--   DELETE FROM sms_send_log WHERE send_type = 'instant_picks';
--   ALTER TABLE sms_send_log DROP CONSTRAINT sms_send_log_send_type_check;
--   ALTER TABLE sms_send_log
--     ADD CONSTRAINT sms_send_log_send_type_check
--     CHECK (send_type IN ('confirm_request','welcome','weekly','empty_week','pause_notice'));
-- `sms_send_log_picks_only_weekly` is NOT touched by this migration and must NOT be touched by its
-- rollback either.
