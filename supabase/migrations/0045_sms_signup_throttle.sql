-- 0045_sms_signup_throttle.sql — the rate-limit counters behind POST /api/sms/signup.
--
-- ═══ THE ABUSE THIS EXISTS TO STOP ═══
-- The signup endpoint had no throttle of any kind. Anyone who knew — or guessed — a phone number
-- could resubmit the form against it as fast as they could POST, and every submission dispatched
-- a fresh confirmation SMS to that handset. The victim is not the attacker: it is a real person
-- whose phone buzzes, who never asked for any of it, and who has no way to make it stop.
-- (lib/sms/signup-store.ts closes the worst version of this in the same change — an ALREADY-ACTIVE
-- subscriber was additionally knocked back to `pending` and had their stored preferences
-- overwritten on every hit — but a number that is merely PENDING, or not in the table at all, is
-- still a handset somebody can be made to buzz on demand.)
--
-- ═══ WHY A NEW TABLE, HAVING FIRST TRIED NOT TO NEED ONE ═══
--   sms_send_log (0035). The obvious candidate — it already carries `phone_hash` and `created_at`
--     with an index on exactly that pair. Rejected on two counts. It records messages that were
--     SENT, so nothing about a REJECTED attempt is visible to it, and it is the CASL audit trail:
--     hanging a network identifier off the one table this repo retains INDEFINITELY (0035's own
--     comment on phone_hash) would turn a compliance record into a surveillance record. Different
--     lifetime, different purpose, different table.
--   sms_consent.consent_timestamp (0034). Re-stamped on every resubmission, so it does answer
--     "when did this number last attempt" — but it holds one timestamp and no count, says nothing
--     about a first-time number, carries no IP, and by design is no longer written at all for the
--     active-subscriber case that started this.
--   In-memory, per instance. Not durable across serverless invocations, i.e. not a throttle.
--
-- ═══ A COUNTER, NOT A LOG — AND THAT SHAPE IS LOAD-BEARING, NOT A SIZE OPTIMISATION ═══
-- The first draft of this migration was an append-only `sms_signup_attempt` row per submission,
-- counted with a windowed aggregate. It reads better and IT DOES NOT WORK, for a reason worth
-- writing down because it is invisible in a single-threaded test:
--
--     SELECT count(*) ... ; -- both requests see 0
--     INSERT ...            ; -- both requests insert
--
-- Two concurrent POSTs for the same number both take their snapshot before either writes, so both
-- are allowed and both send. MVCC does not serialise them, and moving the INSERT into a CTE of the
-- same statement does not either. A serverless endpoint is precisely where an attacker can fire
-- fifty requests at once, so a check-then-insert throttle is a throttle only against callers who
-- politely wait their turn.
--
-- One counter row per subject makes the decision and the write THE SAME OPERATION:
--
--     INSERT ... ON CONFLICT (scope, subject_hash, window_date) DO UPDATE
--        SET attempts = attempts + 1, last_attempt_at = now()
--      WHERE <under the limits>
--     RETURNING attempts;      -- zero rows returned  ⟺  throttled
--
-- ON CONFLICT DO UPDATE takes a row lock, so a concurrent second request BLOCKS, then re-evaluates
-- its WHERE against the row the first one just committed. No window, no lost update, one round
-- trip. And when the WHERE fails the row is not touched at all — so a caller who hammers does not
-- push their own window out, which keeps a double-tapping parent from locking themselves out for
-- the day. See lib/sms/signup-store.ts `checkAndRecordSignupAttempt`.
--
-- ═══ WHAT IS AND IS NOT STORED ═══
-- HASHES ONLY. A 'phone' subject uses the exact construction and salt sms_send_log already uses
-- (lib/sms/phone-hash.ts — HMAC-SHA256 under SMS_PHONE_HASH_SALT), so one number yields one value
-- across both tables and no second secret has to be provisioned before this can ship. An 'ip'
-- subject is the same HMAC under a DIFFERENT domain prefix, so the two families cannot collide
-- despite sharing a salt. Neither a raw phone number nor a raw IP address is ever written here.
--
-- ONE ROW PER SUBJECT PER DAY, so this table's size is bounded by real signup traffic rather than
-- by attack traffic — a caller sending ten thousand requests still occupies one row.
--
-- ═══ RETENTION ═══
-- Nothing here is evidence of anything and none of it should outlive the window it feeds. Any row
-- whose `window_date` is in the past is dead weight, and — being derived from personal data —
-- dead weight with a privacy cost. `idx_sms_signup_throttle_window` exists to make that sweep a
-- cheap ranged delete. ⚠ THE SWEEP ITSELF IS NOT IN THIS MIGRATION AND IS NOT SCHEDULED: it
-- belongs with worker/core/sms-retention.ts and global_job_schedule (0039), which is a different
-- workstream's file. Said out loud rather than left to be discovered, because 0039 exists for the
-- exact reason that 0034 deferred its own purge job and nobody closed it for a year.
--
-- ═══ RLS: default-deny, like every other public table (0017/0018/0033/0034) ═══
-- tests/rls_public_tables.test.ts enumerates the catalog live, so this table is covered by that
-- invariant the moment it exists — which is why the two statements at the bottom are not optional.

-- ── forward ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_signup_throttle (
  -- WHICH KIND of subject this row counts. Two scopes in one table rather than two tables: the
  -- row shape and the whole decision statement are identical, and only the limits differ — which
  -- is a property of the CALLER, not of the storage.
  scope           text NOT NULL CHECK (scope IN ('phone', 'ip')),

  -- HMAC-SHA256(SMS_PHONE_HASH_SALT, 'sms-phone:' || e164)      for scope = 'phone'
  -- HMAC-SHA256(SMS_PHONE_HASH_SALT, 'sms-signup-ip:' || ip)    for scope = 'ip'
  subject_hash    text NOT NULL,

  -- The daily bucket, in UTC so it does not move with the server's timezone. A calendar day
  -- rather than a rolling 24 hours, deliberately: a rolling window needs the per-attempt history
  -- this table exists NOT to keep, and "3 a day" is the shape a person reading an error message
  -- already understands. The cost is a reset at 00:00 UTC, which buys an attacker one extra
  -- window's worth of attempts once per day and is not worth a log table to close.
  window_date     date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,

  -- Attempts we ALLOWED in this bucket. A rejected attempt does not increment it — see the header.
  attempts        integer NOT NULL DEFAULT 1,

  -- When the last ALLOWED attempt happened. Drives the minimum-interval half of the limit, and is
  -- what a Retry-After header is computed from.
  last_attempt_at timestamptz NOT NULL DEFAULT now(),

  -- The conflict target. Being the primary key is what makes the upsert above atomic per subject.
  PRIMARY KEY (scope, subject_hash, window_date)
);

-- The retention sweep's index. See the header: the sweep is not scheduled yet.
CREATE INDEX IF NOT EXISTS idx_sms_signup_throttle_window
  ON sms_signup_throttle (window_date);

COMMENT ON TABLE sms_signup_throttle IS
  'Rate-limit counters for POST /api/sms/signup — one row per (scope, subject, UTC day). Hashes '
  'only: no raw phone number and no raw IP. A short-lived counter, not an audit trail — any row '
  'with a past window_date is safe to delete, unlike sms_send_log, which is retained '
  'indefinitely as CASL evidence.';

COMMENT ON COLUMN sms_signup_throttle.attempts IS
  'Counts ALLOWED attempts only. A throttled request leaves the row untouched, so hammering '
  'cannot extend a caller''s own lockout — which matters because the caller who retries three '
  'times in a minute is usually a parent who did not get the text, not an attacker.';

COMMENT ON COLUMN sms_signup_throttle.scope IS
  'phone = protects one handset from repeated confirmation texts. ip = defence in depth against '
  'one caller spraying MANY different numbers. The IP half derives from a client-influenced '
  'forwarded-for header and is never the only thing between an attacker and somebody''s phone.';

ALTER TABLE sms_signup_throttle ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sms_signup_throttle FROM anon, authenticated;

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS sms_signup_throttle;
