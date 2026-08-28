-- 0034_sms_consent.sql — SMS-primary pivot: the subscriber + consent record.
--
-- STATUS: DRAFT. Not applied to any database by the agent that wrote it. The Operator holds
-- exclusive migration-apply authority on this project; this file exists to be reviewed.
--
-- WHY THIS TABLE EXISTS. The v2 PRD moves the weekly product from an authenticated email
-- digest to an unauthenticated weekly TEXT MESSAGE: five to ten personalised weekend picks,
-- Friday. Nothing in the schema can carry that subscriber today. `user_profile` (0013) is an
-- ACCOUNT — it is keyed on a Supabase auth user, holds an email opt-in, and presupposes a
-- sign-in that this product deliberately does not have. `region_notify_signup` (0033) is a
-- one-shot waiting list with no recurring consent, no preferences and no lifecycle. The SMS
-- subscriber is a third thing: no account, a phone number instead of an address, a CASL
-- express-consent record with its own confirm/pause/stop lifecycle, and the selection inputs
-- (postal code, children's ages, category interests) that the weekly pick job reads. Bolting
-- any of that onto either existing table would merge three different consent scopes into one.
--
-- WHY CONSENT LIVES ON THE SUBSCRIBER ROW, NOT IN A SEPARATE CONSENT TABLE. CASL requires us
-- to be able to prove, per recipient, that express consent was obtained: how it was obtained
-- (`consent_method`), when (`consent_timestamp`), when it was confirmed by the recipient's own
-- reply (`confirmed_timestamp`), and WHICH WORDING they agreed to (`consent_text_version`).
-- Those four facts are properties of this subscription and change only at lifecycle
-- transitions, so they belong on the row that IS the subscription. The append-only SEND-side
-- audit trail — which messages actually went out, under which consent wording — is a separate
-- concern and gets its own table in 0035.
--
-- BIRTH YEARS, NOT AGES. `birth_years` stores one YEAR per child, derived at signup from the
-- plain "how old is your child now" number the form asks for (birth_year = current_year -
-- entered_age). Storing the age itself would silently rot: a row written in 2026 saying "4"
-- still says "4" in 2029. Storing a year means the send job recomputes the age every week and
-- the row never goes stale. It is also the more data-minimal of the two shapes that work — a
-- year is coarser than a birth date, and we deliberately do not ask for month or day.
--   ACCEPTED TRADEOFF, RECORDED HERE ON PURPOSE: with no month, a child's computed age is only
--   right to within a year. A child born in December 2020 reads as 5 for all of 2025 even
--   though they are 4 until December, so age-band placement near a birthday boundary can be
--   off by close to a year in the "too old" direction until the real birthday passes. The PRD
--   accepts this in exchange for not asking parents for a child's date of birth. It is not a
--   defect to be fixed in the selection code.
--
-- SHORT_REF, AND WHY A UUID PRIMARY KEY IS NOT ENOUGH. The weekly text carries one short link
-- per pick, and a link in a 160-character SMS has a hard character budget that a 128-bit UUID
-- (36 characters, or 22 base64url) cannot fit. `short_ref` is a compact, sequence-backed
-- integer alias for this row that the link tokeniser encodes in 24 bits instead of 128
-- (lib/sms/short-link.ts, and the matching column on activity_occurrence in 0037). `id` stays
-- the primary key and the FK target everywhere; `short_ref` is ONLY ever a link-encoding
-- alias. GENERATED ALWAYS (not BY DEFAULT) so nothing can hand-assign one and collide with the
-- sequence. It is guessable by construction — sequential integers are — which is exactly why
-- the token that carries it is HMAC-checked rather than trusted on its face.
--
-- NULLABLE PERSONAL COLUMNS ARE A RETENTION REQUIREMENT, NOT SLOPPINESS. PRD §1.3: 30 days
-- after a subscriber stops, we erase phone_number, postal_code, birth_years and
-- category_interests. That erasure is an UPDATE-to-NULL on this row, not a row delete, because
-- the CASL audit trail in 0035 must keep pointing at a subscription that demonstrably existed.
-- So all four columns are nullable, and NULL on a stopped row means "purged", not "never
-- given". (The purge JOB itself is out of scope for this migration — the schema just has to
-- make it expressible, which is what `stopped_at` and these nullables do.)
--   The second retention rule — pending signups that never confirm are purged after 90 days —
--   IS a row delete, since an unconfirmed signup never produced a commercial message and so has
--   no audit trail to preserve. That is why 0035/0036 reference this table with ON DELETE SET
--   NULL rather than CASCADE: see those files.
--
-- UNIQUE ON phone_number: one live subscription per number, which is what the carrier and CASL
-- both assume. Postgres treats NULLs as distinct in a unique index, so any number of PURGED
-- rows can coexist — the constraint binds only rows that still hold a number. Consequence
-- worth stating: a parent who STOPs and re-JOINs inside the 30-day window hits the existing
-- row rather than creating a second one, so the JOIN handler must REACTIVATE (clear stopped_at,
-- set status/consent_timestamp/consent_text_version afresh) instead of INSERTing. That is the
-- correct CASL behaviour anyway — consent is per number, not per row.
--
-- RLS: default-deny, mirroring 0017/0018/0033. This table holds raw phone numbers, postal codes
-- and children's ages — the most sensitive combination in the schema — so it gets the same two
-- independent barriers as everything else: RLS ENABLED with NO policies (denies every
-- RLS-subject role) plus REVOKE ALL (strips the default anon/authenticated grants at the
-- privilege layer). Written ONLY by the server-side service-level pool (lib/db/client.ts),
-- which owns the table and bypasses RLS by design. tests/rls_public_tables.test.ts enumerates
-- the catalog live, so this table is covered by that invariant without being listed anywhere.

-- ── forward ──────────────────────────────────────────────────────────────────
CREATE TABLE sms_consent (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  short_ref               bigint GENERATED ALWAYS AS IDENTITY UNIQUE,

  -- Personal data. All nullable so the 30-day post-stop purge can erase in place (see header).
  phone_number            text,        -- E.164, e.g. +16045550123. NULL = purged.
  postal_code             text,        -- Canadian postal code / FSA, as entered. NULL = purged.
  birth_years             integer[],   -- one YEAR per child, no month/day. NULL = purged.
  category_interests      text[],      -- category slugs the parent picked. NULL = purged.

  -- CASL consent record.
  status                  text NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','active','paused','stopped')),
  consent_method          text NOT NULL
                            CHECK (consent_method IN ('web_form','sms_start','email_link')),
  consent_timestamp       timestamptz NOT NULL DEFAULT now(),
  confirmed_timestamp     timestamptz,          -- set when they reply JOIN; NULL while pending
  consent_text_version    text NOT NULL,        -- which consent wording they agreed to

  -- Lifecycle / operations.
  consecutive_empty_weeks integer NOT NULL DEFAULT 0 CHECK (consecutive_empty_weeks >= 0),
  preferences_token       text,                 -- HMAC-derived, regenerable; see COMMENT below
  created_at              timestamptz NOT NULL DEFAULT now(),
  stopped_at              timestamptz,          -- NULL unless they have stopped

  -- A stopped row with no stopped_at would never be picked up by the 30-day purge, so the
  -- retention promise would silently not apply to it. Cheap to enforce, expensive to miss.
  CONSTRAINT sms_consent_stopped_has_timestamp
    CHECK (status <> 'stopped' OR stopped_at IS NOT NULL),

  -- E.164 shape check. Not a validity check (only the carrier can tell us that) — it is a
  -- normalisation check, so an un-normalised "(604) 555-0123" can never be written and then
  -- fail to match the same person on a later lookup.
  CONSTRAINT sms_consent_phone_e164
    CHECK (phone_number IS NULL OR phone_number ~ '^\+[1-9][0-9]{7,14}$')
);

-- One live subscription per number (NULLs are distinct → purged rows do not collide).
CREATE UNIQUE INDEX idx_sms_consent_phone ON sms_consent (phone_number);

-- The Friday send scan: "every active subscriber". Partial, because the other three statuses
-- are never the target of a weekly send and there is no reason to index them.
CREATE INDEX idx_sms_consent_active ON sms_consent (id) WHERE status = 'active';

-- The 30-day post-stop purge sweep.
CREATE INDEX idx_sms_consent_stopped_at ON sms_consent (stopped_at) WHERE stopped_at IS NOT NULL;

-- The 90-day never-confirmed purge sweep.
CREATE INDEX idx_sms_consent_pending_since
  ON sms_consent (consent_timestamp) WHERE status = 'pending';

-- Preference-link lookup (the no-login preferences page resolves a subscriber by this token).
CREATE UNIQUE INDEX idx_sms_consent_preferences_token
  ON sms_consent (preferences_token) WHERE preferences_token IS NOT NULL;

COMMENT ON COLUMN sms_consent.short_ref IS
  'Compact sequence-backed alias for this subscriber, used ONLY as the 24-bit subscriber field '
  'inside a weekly SMS short-link token (lib/sms/short-link.ts). Never a foreign-key target — '
  'id remains the identity of this row. Sequential and therefore guessable by construction; '
  'the link token is HMAC-checked precisely because this value is not a secret.';

COMMENT ON COLUMN sms_consent.birth_years IS
  'One birth YEAR per child (no month, no day), derived at signup as current_year - entered_age. '
  'Stored as a year rather than an age so the value does not rot between sends; stored without '
  'month/day so we never hold a child''s date of birth. Consequence, accepted per PRD: a '
  'computed age is only accurate to within a year, so band placement near a birthday can be off '
  'in the "too old" direction until the real birthday passes. NULL = purged 30 days post-stop.';

COMMENT ON COLUMN sms_consent.consecutive_empty_weeks IS
  'How many Fridays in a row we had nothing worth sending this subscriber. Reset to 0 on any '
  'non-empty weekly send. Drives the PRD''s auto-pause: rather than keep texting a parent "no '
  'picks this week", the pipeline pauses the subscription after the configured run of empties.';

COMMENT ON COLUMN sms_consent.preferences_token IS
  'Bearer token for the no-login preferences page, HMAC-derived from this row and a server '
  'secret. Stored (not recomputed on the fly) so it can be ROTATED — regenerating the column '
  'invalidates a leaked link without changing the server secret for everyone. It is a bearer '
  'credential at rest: default-deny RLS plus service-role-only access is what protects it.';

ALTER TABLE sms_consent ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sms_consent FROM anon, authenticated;

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS sms_consent;
