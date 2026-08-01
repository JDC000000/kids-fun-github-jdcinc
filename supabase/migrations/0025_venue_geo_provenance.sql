-- 0025_venue_geo_provenance.sql — venue geo provenance. Give the coordinate a source.
--
-- THE DEFECT THIS IS THE FIRST HALF OF. `venue.geo` is written by EIGHT independent
-- producers through `worker/core/venue.ts::resolveVenue`, whose merge rule is
-- `geo = COALESCE(<incoming>, geo)` — incoming FIRST. Any non-NULL incoming coordinate
-- unconditionally replaces the stored one, so the coordinate a parent sees is whichever
-- adapter's cron fired last. That is not a decision, it is an accident, and it is
-- currently observable: activenet and citycalendar carry five byte-identically-named
-- Vancouver venues, four of which sit up to ~802 m apart and change every time the two
-- adapters run in a different order.
--
-- The fix is a precedence rule, and a precedence rule needs something to compare. That is
-- what this migration adds. The comparison itself is 0025's sibling change in
-- `worker/core/venue.ts` (G-VGEO-A2); this file writes NO coordinate and moves NO data.
--
-- WHY NOT REUSE `source.authority_tier` (0003_core_places.sql:21). Because it answers a
-- different question. `authority_tier` ranks WHO PUBLISHED THE PROGRAMMING; this ranks WHO
-- MEASURED THE COORDINATE, and the two are genuinely orthogonal. ActiveNet is `official`
-- for Vancouver drop-in schedules and is simultaneously the WORST geo source in the system
-- for pools and rinks — the City publishes no pool/rink/arena dataset at all, so 12 of the
-- 36 Vancouver points in `worker/adapters/activenet/venue-geo.ts` are hand-placed.
-- Reusing the column would have been a category error that looked like reuse.
--
-- THE ORDINAL, and the measurement behind each rung (not intuition — every one of these is
-- a number already recorded in the repo). Canonical definition, with the reasoning, lives
-- in `worker/core/venue-geo-authority.ts`; this comment is the DB-side copy so a DBA
-- reading `\d venue` is not sent hunting.
--
--   50  admin manual listing (human, in-product)   a human looked at THIS venue on purpose
--   40  curated w/ per-entry provenance            12 hand-placed pool/rink points; the
--                                                  Britannia convergence measured 139-172 m
--                                                  closer than the City's own point
--   30  committed open-data point                  verbatim from a licensed dataset for
--                                                  that exact facility
--   20  adapter config literal                     curated, but no per-entry provenance and
--                                                  no recorded measurement
--   10  live vendor payload                        third-party, unreviewed, can change
--                                                  silently between runs
--    5  geocoder backfill                          address-derived; already NULL-only by
--                                                  design and STAYS NULL-only (see below)
--    0  legacy / unattributed                      pre-migration incumbents
--
-- THE `geo_authority = 0` BACKFILL IS A ONE-WAY DOOR, AND IT IS INTENDED. Every existing
-- geo-bearing row is stamped 0, so the FIRST declared source to run outranks it and the row
-- settles onto an attributed coordinate — exactly once, then never again. That settling
-- event is captured in the golden baseline (`tests/geo/__fixtures__/venue-geo-baseline.json`)
-- BEFORE it happens, which is why the harness was built first.
--
-- ONE PLACE THE ORDINAL ALONE WOULD HAVE MADE THINGS WORSE, RECORDED RATHER THAN GLOSSED.
-- `scripts/backfill-venue-geo.ts` (the Mapbox geocoder, tier 5) is today the ONLY writer
-- with safe semantics: `... WHERE id = $1 AND geo IS NULL`, strict gap-fill, cannot clobber.
-- Under the authority rule alone, 5 > 0 — so after this backfill the geocoder would be
-- permitted to overwrite every legacy hand-placed coordinate in the system with an
-- address-derived guess. It keeps its `AND geo IS NULL` predicate for exactly that reason.
-- The authority rule is a CEILING on what a writer may do, not a licence; an individual
-- path may be stricter, and that one is, deliberately.
--
-- WHY THE CHECK CONSTRAINT. `geo` and `geo_authority` are NULL together or non-NULL
-- together, enforced in the database. Without it, "every geo-bearing row declares an
-- authority" would be a state this migration establishes once and nothing preserves — and
-- a row that carries a coordinate with no authority is not merely undocumented, it is
-- UNCOMPARABLE: the write rule has nothing to rank it against and would silently fall back
-- to letting anything overwrite it. The constraint makes that unrepresentable rather than
-- unlikely. It is the DB-side counterpart of the static scan in
-- `tests/compliance/venue-geo-authority-declared.test.ts`: one stops a bad write, the other
-- stops the bad code being written.
--
-- NULLABLE, NO DEFAULT, NO VALUE-RANGE CHECK. Most venues will carry no coordinate at all
-- and that is honest. A DEFAULT would silently declare an authority for a row nobody
-- attributed. A range CHECK is deliberately omitted because the ordinal is expected to gain
-- rungs (the tiers are spaced by 5-10 for exactly that reason) and a constraint enumerating
-- today's values would have to be migrated every time one is added — the `>= 0` half IS
-- asserted, because a negative typo would invert every comparison in the write rule.
--
-- FORWARD-ONLY, with the rollback stated at the bottom. The rollback is lossless for
-- coordinates (it drops provenance, not geometry) but it also drops the CHECK, so a
-- rolled-back database can once again accept an unattributed coordinate. That is the cost
-- and it is stated rather than discovered.

-- ── forward ──────────────────────────────────────────────────────────────────
ALTER TABLE venue
  ADD COLUMN geo_authority    smallint,
  ADD COLUMN geo_source       text,
  ADD COLUMN geo_attribution  text,
  ADD COLUMN geo_set_at       timestamptz;

-- The one-way door: every pre-existing coordinate becomes an outrankable legacy incumbent.
-- `geo_source`/`geo_attribution` stay NULL — we genuinely do not know which of the eight
-- producers wrote these rows, and inventing a source would be the precise mistake
-- docs/source-register.md §6.6 records (a venue name is not provenance).
UPDATE venue SET geo_authority = 0 WHERE geo IS NOT NULL;

ALTER TABLE venue
  ADD CONSTRAINT venue_geo_authority_paired
    CHECK ((geo IS NULL) = (geo_authority IS NULL)),
  ADD CONSTRAINT venue_geo_authority_nonnegative
    CHECK (geo_authority IS NULL OR geo_authority >= 0);

COMMENT ON COLUMN venue.geo_authority IS
  'Coordinate-authority ordinal of whoever wrote venue.geo — NOT source.authority_tier, which ranks who published the programming rather than who measured the point. Higher wins; equal authority leaves the incumbent; lower may only fill a NULL. 50 admin / 40 curated-with-provenance / 30 committed open data / 20 adapter config literal / 10 live vendor payload / 5 geocoder backfill / 0 legacy-unattributed. Canonical definition: worker/core/venue-geo-authority.ts.';
COMMENT ON COLUMN venue.geo_source IS
  'Stable identifier for where THIS coordinate came from, e.g. ''activenet:opendata-vancouver'', ''citycalendar:config''. NULL for pre-0025 rows, whose writer is genuinely unknown and is not guessed at.';
COMMENT ON COLUMN venue.geo_attribution IS
  'Third-party licence-notice key this coordinate obliges us to publish (''ogl-vancouver'', ''osm-odbl''), explicit and never inferred. NULL means no third-party notice is owed. Unblocks the per-venue attribution surface that shipped and was pulled in round 50 because the UI inferred provenance from a venue NAME — see docs/source-register.md §6.6 before reintroducing it.';
COMMENT ON COLUMN venue.geo_set_at IS
  'When the winning write landed. Diagnostic only — nothing arbitrates on it, deliberately: arbitrating on a timestamp is the last-writer-wins bug this migration exists to retire.';

-- ── rollback ────────────────────────────────────────────────────────────────
--   ALTER TABLE venue DROP CONSTRAINT IF EXISTS venue_geo_authority_paired;
--   ALTER TABLE venue DROP CONSTRAINT IF EXISTS venue_geo_authority_nonnegative;
--   ALTER TABLE venue DROP COLUMN IF EXISTS geo_set_at;
--   ALTER TABLE venue DROP COLUMN IF EXISTS geo_attribution;
--   ALTER TABLE venue DROP COLUMN IF EXISTS geo_source;
--   ALTER TABLE venue DROP COLUMN IF EXISTS geo_authority;
