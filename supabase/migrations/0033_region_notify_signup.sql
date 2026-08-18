-- 0033_region_notify_signup.sql — "email me when this area is live" capture.
--
-- WHY THIS TABLE EXISTS. Two of the five launch municipalities (West Vancouver, Burnaby)
-- currently hold effectively no listings. /search now says so honestly instead of rendering a
-- thin area as an ordinary result set (lib/search/coverage.ts), and the one useful thing a
-- parent can do from that honest state is ask to be told when it changes. This is where that
-- ask is stored. It is a waiting list, not a mailing list: there is no campaign, no newsletter
-- and no digest attached to it.
--
-- WHY A NEW TABLE. There is no existing email-capture mechanism in the schema to reuse.
-- `weekly_email_send` (0017) is a per-user SEND LOG keyed on user_profile and holds no address
-- at all — the digest resolves addresses from Supabase auth.users at send time. Signing up here
-- requires no account, so there is no user_profile row to hang it off, and the address itself
-- is the entire payload. Bolting an anonymous, address-carrying waiting list onto the
-- authenticated digest's log would confuse two different consent scopes in one place.
--
-- MINIMAL BY DESIGN. Four columns. `region_chip_id` stores the URL slug the /search area chips
-- already use ('van' | 'nvan' | 'wvan' | 'bby' | 'rmd' — app/search/_lib/params.ts REGION_CHIPS,
-- which is the allowlist the API route validates against, so an arbitrary string can never be
-- written here). The human label is derivable from that slug and is deliberately NOT duplicated
-- into a column that could drift from it.
--
-- UNIQUE ON (region, lower(email)): re-submitting the same address for the same area is a
-- parent tapping twice, not a second request. The write is ON CONFLICT DO NOTHING, so a repeat
-- is a silent success rather than an error the form would have to explain. Case-insensitive
-- because a mailbox is, and two rows differing only in capitalisation would mean two emails.
-- The same address may wait on more than one area — that is a genuinely different request.
--
-- RLS: default-deny, mirroring 0017/0018. This table holds raw email addresses submitted by
-- anonymous visitors — the single most sensitive column added to this schema — so it gets the
-- same two independent barriers as everything else: RLS ENABLED with NO policies (denies every
-- RLS-subject role) plus REVOKE ALL (strips the default anon/authenticated grants at the
-- privilege layer). Written ONLY by the server-side service-level pool (lib/db/client.ts), which
-- is the table owner and bypasses RLS by design. tests/rls_public_tables.test.ts enumerates the
-- catalog live, so this table is covered by that invariant without being listed anywhere.
--
-- RETENTION is deliberately not automated here, unlike correction_report (0020). That table
-- stamps `retained_until` by column DEFAULT because its rows age out on a fixed clock; a row
-- here is a standing request that is discharged by an EVENT (the area going live), not by the
-- passage of time, so a time-based default would quietly delete requests we had not yet
-- answered. Purging after the notification is sent belongs with whatever sends it.

-- ── forward ──────────────────────────────────────────────────────────────────
CREATE TABLE region_notify_signup (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region_chip_id text NOT NULL,
  email          text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Dedupe key AND the lookup index for "who is waiting on this area".
CREATE UNIQUE INDEX idx_region_notify_signup_region_email
  ON region_notify_signup (region_chip_id, lower(email));

ALTER TABLE region_notify_signup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON region_notify_signup FROM anon, authenticated;

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS region_notify_signup;
