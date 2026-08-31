-- 0038_sms_area_waitlist.sql — "tell me when you reach my area".
--
-- ⚠ DRAFT FOR OPERATOR REVIEW. NOT APPLIED BY THE AUTHOR OF THIS FILE. Migrations are applied by
-- the Operator only.
--
-- ═══ WHY A NEW TABLE AND NOT region_notify_signup (0033) ═══
-- 0033 exists for /search's "email me when this area is live" list and is keyed on
-- (region_chip_id, lower(email)). It cannot carry this feature for two independent reasons:
--   1. It is EMAIL-keyed. This flow has a phone number and no email, by design — the SMS product
--      has no account and never asks for one.
--   2. It assumes a region CHIP. Scenario B below has no chip: the whole point is a postal code
--      that resolves to NO covered municipality, so there is nothing to key against.
-- Widening 0033 to carry both would make its unique index express two different things at once.
--
-- ═══ THE TWO SCENARIOS, AND WHY THE SCHEMA INSISTS ON EXACTLY ONE ═══
--   A. COVERED BUT SPARSE — a real municipality we serve thinly. `region_chip_id` is set.
--      Ordinary signup remains available; the waitlist is an alternative, not a replacement.
--   B. OUT OF AREA — resolves to none of the five municipalities. `area_fsa` is set.
--      There is no ordinary signup path at all, so the waitlist is the only thing on offer.
-- `num_nonnulls(...) = 1` puts "one or the other, never neither, never both" in the schema rather
-- than in application code, where it would be one forgotten branch away from a row that means
-- nothing.
--
-- ═══ FSA, NOT A FULL POSTAL CODE ═══
-- Three characters is enough to know when we have reached someone, and it is materially less data
-- about a person who is not a customer and may never become one. Jon's own framing, recorded
-- verbatim in lib/sms/surfaces.ts: "let's emphasize capturing the least amount of data we need to
-- provide value." A full postal code would buy nothing here and would be a finer-grained location
-- than the weekly product itself stores for actual subscribers.
--
-- ═══ CONSENT IS SEPARATE FROM sms_consent, DELIBERATELY ═══
-- A waitlist opt-in is a DIFFERENT CONSENT PURPOSE from the weekly picks. These people have not
-- agreed to a weekly text; they have agreed to ONE message, once, if and when we launch near them.
-- Folding that into sms_consent would put two different promises under one consent record and one
-- `consent_text_version`, and no later audit could tell which a given row meant.
--   So: its own table, its own version column, its own timestamp. A row here is NOT a subscriber
--   and must never be counted as one.
--
-- ═══ RETENTION (Jon, 2026-08-31) ═══
-- Deliberately reusing 0034's existing numbers rather than inventing new ones, so there is ONE
-- retention story across the product rather than two nearly-identical ones:
--   · 30 days after `notified_at` — mirrors 0034's 30-day post-stop purge. Once we have sent the
--     one message we promised, the reason to hold the number is gone.
--   · 90 days after `created_at` for rows never notified — mirrors 0034's 90-day
--     never-confirmed purge. An area we have not reached in 90 days is not one this row should
--     keep waiting for.
-- As in 0034, the purge JOB is out of scope for this migration; the schema has to make the rule
-- expressible, and `notified_at` / `created_at` are what do that.

CREATE TABLE sms_area_waitlist (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- E.164, same shape as sms_consent.phone_number. Same CHECK, deliberately copied rather than
  -- loosened: a number that could not be stored as a subscriber must not be storable here either.
  phone_number             text NOT NULL
                             CHECK (phone_number ~ '^\+[1-9][0-9]{7,14}$'),

  -- Scenario A. Matches REGION_CHIPS ids ('van','nvan','wvan','bby','rmd').
  region_chip_id           text,
  -- Scenario B. The 3-character forward sortation area, uppercase, e.g. 'V3S'.
  area_fsa                 text CHECK (area_fsa ~ '^[A-Z][0-9][A-Z]$'),
  CONSTRAINT sms_area_waitlist_exactly_one_area
    CHECK (num_nonnulls(region_chip_id, area_fsa) = 1),

  -- The waitlist's OWN consent version — NOT sms_consent.consent_text_version. See above.
  waitlist_consent_version text NOT NULL,
  consent_timestamp        timestamptz NOT NULL DEFAULT now(),

  -- Set when the one promised message is sent, so it cannot be sent twice, and so the 30-day
  -- purge has something to measure from.
  notified_at              timestamptz,
  -- CASL opt-out, available before any message has been sent at all.
  unsubscribed_at          timestamptz,

  created_at               timestamptz NOT NULL DEFAULT now()
);

-- One waiting row per number per area. COALESCE rather than two partial indexes: the pair is the
-- identity regardless of which scenario produced it, and a number may legitimately wait on more
-- than one area (a family moving between them).
CREATE UNIQUE INDEX idx_sms_area_waitlist_number_area
  ON sms_area_waitlist (phone_number, coalesce(region_chip_id, area_fsa));

-- The send job's read pattern: who is still waiting for an area we have just reached.
CREATE INDEX idx_sms_area_waitlist_pending
  ON sms_area_waitlist (coalesce(region_chip_id, area_fsa))
  WHERE notified_at IS NULL AND unsubscribed_at IS NULL;

-- Same posture as 0033 and 0034: service-role only, nothing reachable by anon or authenticated.
ALTER TABLE sms_area_waitlist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sms_area_waitlist FROM anon, authenticated;

COMMENT ON TABLE sms_area_waitlist IS
  'One-time "we have reached your area" notifications. NOT subscribers: these numbers have not '
  'consented to the weekly text. Consent here is separate and single-purpose — see '
  'lib/sms/waitlist-copy.ts and this file''s header.';
COMMENT ON COLUMN sms_area_waitlist.area_fsa IS
  'Forward sortation area only (3 chars), never a full postal code — enough to know when we have '
  'reached someone, and the least data that achieves it.';
COMMENT ON COLUMN sms_area_waitlist.notified_at IS
  'When the single promised message was sent. NULL = still waiting. Purge target: 30 days after '
  'this, mirroring 0034''s post-stop rule.';
