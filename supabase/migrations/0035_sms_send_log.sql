-- 0035_sms_send_log.sql — SMS-primary pivot: append-only record of every text we sent.
--
-- STATUS: DRAFT. Not applied by the agent that wrote it; the Operator applies migrations.
--
-- WHY THIS TABLE EXISTS — the same two jobs 0017 does for email, for a channel where the
-- second one is much harder to satisfy:
--   1. WATERMARK. The weekly picker needs "what is new for this subscriber since we last
--      texted them", and MAX(created_at) for the subscriber is that watermark, exactly as
--      MAX(sent_at) is in weekly_email_send.
--   2. CASL AUDIT TRAIL. Canadian anti-spam law expects a record of what commercial electronic
--      messages were sent, to whom, when, and under which consent wording. For SMS this is the
--      whole compliance story: there is no mailbox provider in the middle, the recipient is
--      identified by a phone number rather than an account, and the regulator's question is
--      about the NUMBER, not about a user row.
--
-- ═══ THE ONE REAL DESIGN DECISION HERE: THIS LOG MUST OUTLIVE ITS SUBSCRIBER ═══
--
-- 0017 chose `user_id ... REFERENCES user_profile(id) ON DELETE CASCADE` and said why: account
-- deletion hard-deletes the profile, the cascade keeps that deletion from failing on an FK
-- violation, and "delete my account also removes the send history" was judged the stronger
-- privacy posture. That reasoning was right for that table and it is WRONG here, in the
-- direction that matters most, because the two tables sit under different obligations:
--
--   * weekly_email_send's recipient identity is already pseudonymous (a user_id — the address
--     itself lives only in Supabase auth.users), so cascading it away costs little proof.
--   * sms_send_log's whole evidentiary value is the link between a REAL PHONE NUMBER and a
--     commercial message. If a subscriber row disappearing takes the log with it, then the
--     exact scenario CASL exists for — "you texted me and I never consented" — is the scenario
--     in which we have destroyed our own evidence. A retention rule cannot be allowed to erase
--     the record that proves the retention rule was followed.
--
-- So the FK is `ON DELETE SET NULL` over a NULLABLE subscriber_id, and every row additionally
-- carries `phone_hash`, which is NOT NULL and is never purged. After a subscriber row is
-- deleted (PRD §1.3: pending signups that never confirm are removed after 90 days), the log
-- row survives with subscriber_id NULL and phone_hash intact, and the audit question is still
-- answerable: hash the number in the complaint, look it up here, read the send history.
--
-- WHY A SALTED HASH AND NOT THE NUMBER ITSELF. Retaining the plaintext number forever would
-- defeat the purge in 0034 — the number would simply live on over here — so the audit trail
-- keeps a one-way, SALTED digest instead. Salted, with a server-side secret salt, because an
-- unsalted hash of a phone number is not a pseudonym at all: the whole North American number
-- space is ~10^10 candidates, which is a few seconds of brute force. The salt is what makes
-- this column a lookup key for someone who already holds a number, rather than a reversible
-- index of every number we ever texted. The salt is NOT stored in this table.
--
-- APPEND-ONLY. Nothing in the app ever UPDATEs or DELETEs a row here, with one deliberate
-- exception: `delivery_status` is written twice — once at send time from the Twilio API
-- response, then again when Twilio's status-callback webhook reports the carrier's final
-- verdict. That is a late-arriving fact about the same message, not a rewrite of history.
-- `twilio_sid` is what the callback matches on, which is why it is indexed.
--
-- RLS: default-deny, mirroring 0017/0018/0033/0034 — RLS ENABLED with NO policies, plus
-- REVOKE ALL to strip the default anon/authenticated grants. Written ONLY by the service-level
-- pool, which owns the table and bypasses RLS by design.

-- ── forward ──────────────────────────────────────────────────────────────────
CREATE TABLE sms_send_log (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Nullable BY DESIGN + ON DELETE SET NULL: the audit trail outlives the subscriber row.
  subscriber_id        uuid REFERENCES sms_consent(id) ON DELETE SET NULL,

  -- The durable recipient identity. Salted one-way digest of the E.164 number, retained
  -- indefinitely as the CASL audit trail. NOT NULL on every row, including rows that still
  -- have a live subscriber_id — populating it only after a purge would leave the pre-purge
  -- history unsearchable by number, which is the only way anyone will ever search it.
  phone_hash           text NOT NULL,

  send_type            text NOT NULL
                         CHECK (send_type IN ('confirm_request','welcome','weekly',
                                              'empty_week','pause_notice')),

  -- Which occurrences we recommended, and in what order: [{ "occurrence_id": ..., "rank": 1 }].
  -- A SNAPSHOT, not a join: it must still answer "what did this text actually say" after the
  -- catalogue has moved on, been re-ingested, or archived those rows. Weekly sends only.
  picks_snapshot       jsonb,

  outcome              text NOT NULL
                         CHECK (outcome IN ('sent','empty','paused',
                                            'stopped_via_carrier','failed')),

  twilio_sid           text,          -- NULL for a dry-run row or a send that never dispatched
  delivery_status      text,          -- last known carrier status; updated by the Twilio callback
  consent_text_version text NOT NULL, -- the wording in force AT SEND TIME, copied not joined
  created_at           timestamptz NOT NULL DEFAULT now(),

  -- picks_snapshot belongs to weekly sends only. Without this, an 'empty_week' row carrying a
  -- picks array would be a self-contradicting audit record.
  CONSTRAINT sms_send_log_picks_only_weekly
    CHECK (picks_snapshot IS NULL OR send_type = 'weekly')
);

-- Watermark lookup: latest send per subscriber (mirrors idx_weekly_email_send_user).
CREATE INDEX idx_sms_send_log_subscriber ON sms_send_log (subscriber_id, created_at DESC);

-- The audit query, and the ONLY one that still works after a subscriber row is gone:
-- "show me every message ever sent to this number".
CREATE INDEX idx_sms_send_log_phone_hash ON sms_send_log (phone_hash, created_at DESC);

-- Twilio status-callback matching.
CREATE INDEX idx_sms_send_log_twilio_sid ON sms_send_log (twilio_sid) WHERE twilio_sid IS NOT NULL;

COMMENT ON COLUMN sms_send_log.subscriber_id IS
  'Nullable on purpose. ON DELETE SET NULL rather than 0017''s CASCADE: deleting a subscriber '
  'must not destroy the CASL evidence that we did or did not text that number. NULL means the '
  'subscriber row has since been purged, never that the send was anonymous — phone_hash still '
  'identifies the recipient.';

COMMENT ON COLUMN sms_send_log.phone_hash IS
  'Salted one-way digest of the recipient''s E.164 number, retained INDEFINITELY as the CASL '
  'audit trail — deliberately outliving sms_consent.phone_number, which is purged 30 days after '
  'a subscriber stops. Salted with a server-side secret (not stored in this table) because an '
  'unsalted digest over the ~10^10 North American number space is trivially reversible.';

COMMENT ON COLUMN sms_send_log.consent_text_version IS
  'The consent wording in force when THIS message was sent, copied onto the row rather than '
  'joined from sms_consent. A join would report today''s wording for a message sent under last '
  'year''s, which is precisely the fact an audit is asking about.';

ALTER TABLE sms_send_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sms_send_log FROM anon, authenticated;

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS sms_send_log;
