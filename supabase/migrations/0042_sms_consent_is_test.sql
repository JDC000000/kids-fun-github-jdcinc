-- 0042 — mark a consent row as belonging to a TEST handset, so the real weekly send cannot reach it.
--
-- WHY A COLUMN RATHER THAN EXCLUDING A NUMBER IN A QUERY.
-- The alternative was `AND phone_number <> '+1778...'` wherever it mattered. That breaks silently
-- the day the test number is reassigned, released or replaced: the literal stops matching, every
-- query keeps returning rows, and nothing anywhere reports that the exclusion stopped excluding.
-- A column states the fact on the row itself and cannot drift out of agreement with reality.
--
-- DEFAULT false, NOT NULL: every existing row is real, and a nullable flag would make
-- `is_test = false` silently skip rows where the answer is merely unknown. There is no third state
-- here — a row either came in on a test number or it did not.
--
-- THIS COLUMN IS A SAFETY PROPERTY, NOT A REPORTING CONVENIENCE. Its first consumer is
-- loadActiveSubscribers() in lib/sms/weekly-send-io.ts, which is what the Friday job iterates. A
-- test handset completing a real signup would otherwise become an ordinary `active` row and be
-- texted through the production pipeline.
ALTER TABLE sms_consent
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

-- Partial index on the real rows only. Every production read filters `is_test = false`, and the
-- test population is expected to be a handful of rows forever, so indexing the common case is
-- the whole benefit.
CREATE INDEX IF NOT EXISTS idx_sms_consent_active_real
  ON sms_consent (status)
  WHERE is_test = false;

COMMENT ON COLUMN sms_consent.is_test IS
  'True when this row was confirmed via a JOIN that arrived at a test number (SMS_TEST_NUMBERS). Excluded from loadActiveSubscribers() so the production weekly send cannot text a test handset.';
