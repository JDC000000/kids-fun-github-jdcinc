-- 0043_sms_consent_delete_audit.sql — record the fact of a hard DELETE on sms_consent.
--
-- STATUS: DRAFT. The Operator applies migrations; this file exists to be reviewed.
--
-- ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
-- The 2026-09-04 audit found 13 sms_send_log rows with `subscriber_id IS NULL` whose consent
-- row is gone. The rows themselves are not a defect — 0035 chose ON DELETE SET NULL precisely
-- so the CASL trail outlives the subscriber, and phone_hash on those rows is intact, so the
-- audit question ("what did you send this number, when, under which wording") is still
-- answerable. What is NOT answerable is the other question: WHO deleted the consent rows, WHEN,
-- and from where. Nothing in the database recorded that, so the investigation ended in an
-- inference rather than a fact.
--
-- Note what the repository can already establish about that gap, because it narrows what this
-- table is for. `DELETE FROM sms_consent` appears in exactly one place in shipped code —
-- purgeUnconfirmedSignups in lib/retention/sms.ts — and after this migration's sibling change it
-- appears in NONE. That job has also never run: 0039 seeds its schedule `enabled = false`, and
-- the 2026-09-01 production check returned zero `cron.job` rows. So the deletes that produced
-- those 13 rows came from OUTSIDE the application: a script, a DB-backed test suite pointed at
-- the wrong database (which has happened here before — Round 27), or a hand-run statement.
-- Those are exactly the paths no amount of application-level care can cover, and exactly the
-- paths a trigger does cover.
--
-- ── WHY A DEDICATED TABLE AND NOT admin_audit_log ───────────────────────────
-- admin_audit_log (0007/0014) is keyed on an admin_user_id — it records an action taken by a
-- signed-in administrator through the admin UI. A trigger has no admin user and, by the whole
-- premise above, the deletes worth catching are the ones with no human session behind them at
-- all. Writing them there would mean either a NULL in a column the table's readers assume is
-- populated, or a synthetic admin row that is a lie. This table is small, single-purpose and
-- append-only, and it costs one INSERT on an operation that should occur zero times a year.
--
-- ── WHY BEFORE DELETE AND NOT AFTER DELETE ──────────────────────────────────
-- MEASURED, not assumed. phone_hash is the one identifier that makes a logged deletion useful:
-- it is what re-links the surviving sms_send_log rows to the consent row that was removed, and
-- it is the ONLY way to do so, because the FK action nulls subscriber_id and takes that link
-- with it. The salt that produces it is a Node-side secret (lib/sms/phone-hash.ts) that must
-- never be readable from the database — an unsalted digest over the ~10^10 NANP space is
-- reversible, so a salt stored beside the hashes would defeat the column's entire purpose. That
-- leaves exactly one correct source for the hash: the sms_send_log rows the app already wrote.
--
-- Reading them requires the FK link to still exist when the trigger runs, and it does not under
-- AFTER. Probed against a real Postgres on this schema: the internal RI trigger implementing
-- ON DELETE SET NULL fires BEFORE a user AFTER-ROW trigger, so an AFTER DELETE trigger sees
-- `subscriber_id` already NULL and captures nothing.
--
--     AFTER  DELETE trigger →  phone_hash NULL, 0 send-log rows visible
--     BEFORE DELETE trigger →  phone_hash 'HASH_XYZ', 1 send-log row visible
--
-- So BEFORE it is. The two are equivalent for durability — trigger and DELETE share one
-- transaction, so a rolled-back delete rolls back its log row — and they differ only in the one
-- respect that matters here. The residual asymmetry is stated rather than hidden: if some future
-- BEFORE DELETE trigger on this table were to cancel the delete by returning NULL, this row
-- would record a deletion that did not happen. There is no such trigger, and a false positive in
-- an audit log is the failure direction to prefer.
--
-- ── FAILS CLOSED ────────────────────────────────────────────────────────────
-- No exception handler. If the log row cannot be written the DELETE does not happen, which is
-- the correct posture for the one control whose absence created this task: an unrecordable
-- deletion of the most sensitive table in the schema should not proceed quietly. The only write
-- is an INSERT into a table this migration owns.
--
-- SECURITY DEFINER + locked search_path, for 0021's reason: the function must read sms_send_log
-- and write this table as ground truth regardless of who issued the DELETE. Both tables are
-- default-deny RLS, and every writer today is the owner (which bypasses RLS), so this is
-- belt-and-suspenders — it guarantees the control still works if a non-owner is ever granted
-- DELETE on sms_consent, which is precisely the scenario it exists for.
--
-- ── WHAT IS AND IS NOT RECORDED ─────────────────────────────────────────────
-- NO PERSONAL DATA. Not the phone number, not the postal code, not the birth years. This table
-- outlives the row it describes by design, so putting personal columns in it would relocate the
-- data a deletion was supposed to remove — the same trap 0035 avoided by hashing. What it holds
-- is the shape of the event: which row, when, under which database role, from which client, and
-- whether the row still held live personal data at the moment it was destroyed.
--
-- `had_phone_number` is that last distinction and it is the triage question. A deleted row with
-- phone_number already NULL was an exhausted shell; a deleted row with a number in it was live
-- personal data, and the two deserve very different responses at 9am.
--
-- IDEMPOTENT: IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS throughout.
-- Deps: 0034 (sms_consent), 0035 (sms_send_log.phone_hash, phone_hash_version).

-- ── forward ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_consent_delete_log (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- The row that was destroyed. NOT a foreign key, and it cannot be one: the target is gone by
  -- the time this row means anything.
  consent_id          uuid        NOT NULL,
  short_ref           bigint,
  status              text,
  consent_timestamp   timestamptz,

  -- True if the row still held a phone number when it was deleted, i.e. this deletion destroyed
  -- live personal data rather than an already-purged shell.
  had_phone_number    boolean     NOT NULL,

  -- Copied from the surviving sms_send_log rows, never recomputed here (the salt is a Node-side
  -- secret and must stay out of this database). NULL when the subscriber had no send rows —
  -- a signup deleted before we ever texted it, which is a fact worth having in itself.
  phone_hash          text,
  phone_hash_version  smallint,
  send_log_rows       integer     NOT NULL,

  deleted_at          timestamptz NOT NULL DEFAULT now(),

  -- The "who and from where" the 2026-09-04 investigation had no source for. current_user names
  -- the database role; application_name is what a connection string or a pg client sets, which
  -- is what distinguishes the Fly worker from psql on somebody's laptop; client_addr is NULL for
  -- a unix-socket connection, which is itself informative.
  db_user             text        NOT NULL,
  application_name    text,
  client_addr         inet
);

-- "Was this id ever deleted, and when" — the lookup that answers the question this table exists
-- for. Plain, not unique: an id could in principle be reinserted and deleted again.
CREATE INDEX IF NOT EXISTS idx_sms_consent_delete_log_consent
  ON sms_consent_delete_log (consent_id);

-- "These orphaned send-log rows carry hash H — which consent row did they belong to, and when
-- did it go?" This is the join that was impossible on 2026-09-04.
CREATE INDEX IF NOT EXISTS idx_sms_consent_delete_log_phone_hash
  ON sms_consent_delete_log (phone_hash) WHERE phone_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION log_sms_consent_delete() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_phone_hash    text;
  v_hash_version  smallint;
  v_send_rows     integer;
BEGIN
  -- Most recent send row wins: if the salt was ever rotated, the newest hash is the one a
  -- present-day lookup will match, and phone_hash_version records which salt made it.
  SELECT l.phone_hash, l.phone_hash_version
    INTO v_phone_hash, v_hash_version
    FROM sms_send_log l
   WHERE l.subscriber_id = OLD.id
   ORDER BY l.created_at DESC
   LIMIT 1;

  SELECT count(*) INTO v_send_rows FROM sms_send_log l WHERE l.subscriber_id = OLD.id;

  INSERT INTO sms_consent_delete_log
    (consent_id, short_ref, status, consent_timestamp, had_phone_number,
     phone_hash, phone_hash_version, send_log_rows,
     db_user, application_name, client_addr)
  VALUES
    (OLD.id, OLD.short_ref, OLD.status, OLD.consent_timestamp, OLD.phone_number IS NOT NULL,
     v_phone_hash, v_hash_version, v_send_rows,
     current_user, nullif(current_setting('application_name', true), ''), inet_client_addr());

  RETURN OLD;  -- returning NULL here would silently CANCEL the delete
END;
$$;

DROP TRIGGER IF EXISTS trg_sms_consent_delete_audit ON sms_consent;
CREATE TRIGGER trg_sms_consent_delete_audit
  BEFORE DELETE ON sms_consent
  FOR EACH ROW EXECUTE FUNCTION log_sms_consent_delete();

COMMENT ON TABLE sms_consent_delete_log IS
  'Append-only record that a row was hard-DELETEd from sms_consent, written by the '
  'trg_sms_consent_delete_audit trigger. Exists because the 2026-09-04 audit found 13 '
  'sms_send_log rows whose consent row had been deleted with nothing anywhere recording who did '
  'it or when. Holds NO personal data — the phone_hash is copied from the surviving send-log '
  'rows, which is the only link between them and the row that is gone.';

COMMENT ON COLUMN sms_consent_delete_log.had_phone_number IS
  'True when the deleted row still held a phone number, i.e. the deletion destroyed live '
  'personal data rather than an already-purged shell. The triage question.';

COMMENT ON COLUMN sms_consent_delete_log.phone_hash IS
  'Copied from the newest sms_send_log row that pointed at the deleted subscriber — never '
  'recomputed here, because the salt is a Node-side secret (lib/sms/phone-hash.ts) and storing '
  'it beside the hashes would make the column reversible. NULL means the subscriber had no send '
  'rows at all. Requires the trigger to run BEFORE DELETE: the FK''s ON DELETE SET NULL fires '
  'first among AFTER triggers and takes the link with it.';

-- Default-deny, mirroring 0017/0018/0033/0034/0035. RLS ENABLED with NO policies, plus REVOKE
-- ALL to strip the default anon/authenticated grants. tests/rls_public_tables.test.ts enumerates
-- the catalog live, so this table is covered by that invariant without being listed anywhere.
ALTER TABLE sms_consent_delete_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sms_consent_delete_log FROM anon, authenticated;

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP TRIGGER IF EXISTS trg_sms_consent_delete_audit ON sms_consent;
--   DROP FUNCTION IF EXISTS log_sms_consent_delete();
--   DROP TABLE IF EXISTS sms_consent_delete_log;
