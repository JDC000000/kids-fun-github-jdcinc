-- 0037_activity_occurrence_short_ref.sql — a compact integer alias for an occurrence, so a
-- weekly SMS link can fit in an SMS.
--
-- STATUS: DRAFT. Not applied by the agent that wrote it; the Operator applies migrations.
--
-- ═══ WHY THIS MIGRATION EXISTS AT ALL — IT IS NOT ONE OF THE THREE THE PRD NAMED ═══
--
-- The PRD's data-model section lists three new tables (0034-0036) and no schema change to the
-- existing catalogue. This fourth migration is a consequence of trying to actually BUILD the
-- PRD's short link, and it is flagged here rather than slipped in quietly.
--
-- PRD §2.3 asks for an "~8 character" link token encoding "occurrence id + a truncated HMAC
-- check value", computed on request, with no new lookup table. The no-lookup-table half is a
-- good constraint and this migration keeps it. The character budget is where it breaks:
--
--     8 base62 characters = 8 x log2(62) = 47.6 bits of total capacity.
--     activity_occurrence.id is a uuid            = 128 bits.
--
-- The reference alone is 2.7x the entire budget before a single bit of integrity check, and
-- before the subscriber reference the PRD ALSO needs (the token must differ per subscriber or a
-- click cannot be attributed to anyone). Widening the token to fit a raw UUID is not an option
-- either: 128 + 24 + 16 bits is ~29 base62 characters, which is longer than the UUID it was
-- meant to shorten.
--
-- So the UUID has to stop being the thing carried in the link. `short_ref` is a compact,
-- sequence-backed integer alias for an occurrence — 32 bits in the token instead of 128 —
-- while `id` remains the primary key, the FK target, and the identity of the row everywhere
-- else. The token decoder resolves short_ref -> row with an indexed lookup, which is the same
-- single indexed read the UUID would have cost; the PRD's "no new lookup TABLE" constraint is
-- honoured (nothing new to join, no mapping table, no write on link creation) even though the
-- literal "~8 characters" is not. See lib/sms/short-link.ts for the full bit budget and
-- docs/sms-pivot-draft-feasibility-notes.md for the sign-off this deviation still needs.
--
-- WHY AN IDENTITY COLUMN AND NOT A HASH OF THE UUID. A truncated hash of the id would need no
-- column, and would reintroduce collisions: 32 bits over a growing catalogue hits a ~50%
-- birthday collision probability around 77k rows, and a collision here silently sends a parent
-- to the wrong activity. A sequence cannot collide. GENERATED ALWAYS (not BY DEFAULT) so no
-- writer can hand-assign a value and fight the sequence.
--
-- HEADROOM. The catalogue holds roughly 5,600 live occurrences today and the column is bigint,
-- so the column itself never runs out. The binding limit is the TOKEN's 32-bit field: 4.29
-- billion values. Because identity numbers are consumed by every INSERT including ones later
-- archived or deleted, the number that matters is lifetime inserts, not live rows — at the
-- current re-ingest volume that is several thousand years of headroom. If it ever became a
-- real concern, OCCURRENCE_REF_BITS in lib/sms/short-link.ts is one named constant.
--
-- NOT A SECRET. Sequential integers are enumerable and adjacent values are guessable; the row
-- they point at is public catalogue data, so that is not a confidentiality problem. It IS why
-- the link token is HMAC-checked rather than trusted on its face — the check value stops a
-- guessed token from being credited as a real click, not from revealing anything.
--
-- DEPLOY NOTE — THIS ONE IS NOT A FREE ALTER. Unlike 0032's nullable ADD COLUMN, an identity
-- column is implicitly NOT NULL and must be materialised for every existing row, so this
-- statement REWRITES the table under an ACCESS EXCLUSIVE lock. At ~5,600 rows that is
-- sub-second and safe to run live; it would not be at a thousand times the size, and a future
-- reader copying this pattern onto a big table should know that. Apply to
-- kids-fun-supabase-staging and kids-fun-supabase-prod as two separate deliberate steps (0027).
--
-- ORDER RELATIVE TO CODE: additive and read-only from the app's perspective — nothing existing
-- SELECTs or INSERTs this column, so unlike 0031/0032 there is no worker-build ordering hazard.
-- The SMS link code is the only future reader and it does not exist in production yet.

-- ── forward ──────────────────────────────────────────────────────────────────
ALTER TABLE activity_occurrence ADD COLUMN short_ref bigint GENERATED ALWAYS AS IDENTITY;

-- Both the uniqueness guarantee and the decode-path lookup index. The link decoder's only
-- query is `WHERE short_ref = $1`, so this index is on the hot path of every tapped link.
CREATE UNIQUE INDEX idx_activity_occurrence_short_ref ON activity_occurrence (short_ref);

COMMENT ON COLUMN activity_occurrence.short_ref IS
  'Compact sequence-backed alias for this occurrence, existing for exactly one reason: a weekly '
  'SMS short link cannot carry a 128-bit uuid inside a ~13-character token (see '
  'lib/sms/short-link.ts). Encoded as the 32-bit occurrence field of that token; resolved back '
  'to a row by the unique index above. NEVER a foreign-key target and never an identity — id '
  'remains the identity of this row everywhere else in the schema. Enumerable by construction, '
  'which is fine (the row is public catalogue data) and is why the token is HMAC-checked.';

-- Rollback (manual, forward-only runner never executes this):
--   DROP INDEX IF EXISTS idx_activity_occurrence_short_ref;
--   ALTER TABLE activity_occurrence DROP COLUMN IF EXISTS short_ref;
