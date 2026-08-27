-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- ██  TESTING ONLY.  LOCAL LOOPBACK DB ONLY.  NEVER ADD THIS FILE TO supabase/seeds/.  ██
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- kf-sms-v2-test-catalogue.sql — a synthetic weekend catalogue for the KIDS FUN SMS v2
-- manual test harness. Every activity, venue and series in this file is FABRICATED. None of
-- it was ingested from a source; none of it describes a session that exists.
--
-- ── WHY THIS FILE IS NOT IN supabase/seeds/ ────────────────────────────────────────────────
-- scripts/seed.sh globs `supabase/seeds/*.sql` UNCONDITIONALLY and applies every match to
-- $DATABASE_URL. That runner exists for legitimate reference data (regions, age bands,
-- categories, tags, the source registry) and someone re-running it against staging or
-- production for those reasons is a normal, correct thing to do. If this file lived beside
-- them it would need no bug and no mistake to plant a fake catalogue in a real database —
-- just a routine seed run. Living outside that directory is the ONLY thing that stops it,
-- so DO NOT move it, symlink it, or add its directory to seed.sh's glob.
--
-- ── HOW TO APPLY (Operator only) ───────────────────────────────────────────────────────────
--     psql "postgresql://…@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -1 \
--          -f scripts/testing/kf-sms-v2-test-catalogue.sql
--
-- Check the host before you press enter. 127.0.0.1:54322 is the local Supabase loopback.
-- This file has NEVER been executed by the agent that wrote it, against any database.
--
-- ── DATES ARE RELATIVE. ALWAYS. ────────────────────────────────────────────────────────────
-- Not one literal date appears below. Every timestamp is derived from now() at apply time.
-- The proof of why: the local DB's single pre-existing occurrence is a `Baby Storytime`
-- pinned to a hard-coded 2026-07-15, which quietly stopped being a weekend test fixture the
-- moment that date passed and is now invisible to every query the product makes.
--
-- The anchor is THE NEXT SATURDAY THAT IS STRICTLY IN THE FUTURE, computed in
-- America/Vancouver (the product's display timezone) and stored as timestamptz:
--
--     isodow: Mon=1 … Sat=6 … Sun=7
--     offset_days = ((6 - isodow(today) + 6) % 7) + 1     -- Fri→1, Sat→7, Sun→6, Mon→5
--
-- The `+ 6 … + 1` form rather than the obvious `% 7` is deliberate: it can never return 0,
-- so running this ON a Saturday anchors to NEXT Saturday instead of to a weekend that is
-- already half over. Re-running the file at any time re-points every occurrence at the
-- upcoming weekend — that is what makes it idempotent in the way that actually matters here.
--
-- ── IDEMPOTENCY ────────────────────────────────────────────────────────────────────────────
-- Every INSERT is an ON CONFLICT upsert on a fixed UUID (or on the natural key, for the
-- source row), the same pattern supabase/seeds/regions.sql uses. Re-running is safe and
-- refreshes the dates. `activity_occurrence.short_ref` is GENERATED ALWAYS AS IDENTITY and is
-- therefore NEVER written here, which means a re-run does NOT renumber it: short links minted
-- from an earlier run keep resolving to the same rows.
--
-- ── WHY THE UUIDs LOOK LIKE THAT ───────────────────────────────────────────────────────────
-- Every id is v4-SHAPED (`…-4xxx-8xxx-…`) on purpose. lib/search/postgres-repository.ts
-- guards its by-id lookup with a strict UUID regex that requires a version nibble of 1–5 and
-- a variant nibble of 8/9/a/b. A tidy `…-0000-0000-…` id (the shape supabase/seeds/regions.sql
-- uses for regions, where nothing checks) would insert fine and then 404 on /activity/{id} —
-- i.e. every short link in every test text would be dead.
--
-- ── WHAT THIS CREATES ──────────────────────────────────────────────────────────────────────
--     1 source, 15 venues (3 per municipality), 15 series, 34 occurrences.
--     34 = 30 PICKABLE (6 per municipality) + 4 DELIBERATE NEGATIVE CONTROLS.
--
-- The 4 controls are the difference between "the visibility gates work" and "the seed simply
-- contained nothing to hide". They are listed and explained in section 5.
--
-- Coverage is the five municipalities lib/geo/postal-fsa.ts calls covered. A subscriber's
-- postal code resolves to their MUNICIPALITY CENTROID, so every venue below is placed within
-- DEFAULT_RADIUS_KM (10km) of its own centroid — most within 5km, so the narrow radius option
-- also returns results. Test postal codes, one per municipality:
--
--     V5L 1A1 → Vancouver        V7L 1A1 → North Vancouver    V7V 1A1 → West Vancouver
--     V5H 1A1 → Burnaby          V6Y 1A1 → Richmond
--
-- Ages, cost and category are spread so the picks pipeline has something to actually decide:
-- four age bands are represented in every municipality (so the coverage swap has material),
-- both free and priced rows exist, and six categories are used. Titles are distinct WITHIN a
-- municipality so the 0.78 title-similarity dedup never collapses one below FLOOR_PICKS (3);
-- titles REPEAT across municipalities, which is safe because dedup also requires the two
-- venues to be within 0.5km of each other.
--
-- ── TEARDOWN ───────────────────────────────────────────────────────────────────────────────
-- Everything hangs off one source row, so removal is exact. Copy-paste, in this order:
--
--     DELETE FROM occurrence_category_tag WHERE occurrence_id IN (
--       SELECT o.id FROM activity_occurrence o JOIN activity_series s ON s.id = o.series_id
--       WHERE s.source_id = '5e000000-0000-4000-8000-000000000001');
--     DELETE FROM occurrence_age WHERE occurrence_id IN (
--       SELECT o.id FROM activity_occurrence o JOIN activity_series s ON s.id = o.series_id
--       WHERE s.source_id = '5e000000-0000-4000-8000-000000000001');
--     DELETE FROM activity_occurrence WHERE series_id IN (
--       SELECT id FROM activity_series WHERE source_id = '5e000000-0000-4000-8000-000000000001');
--     DELETE FROM activity_series WHERE source_id = '5e000000-0000-4000-8000-000000000001';
--     DELETE FROM venue WHERE id::text LIKE '5e100000-%';
--     DELETE FROM source WHERE id = '5e000000-0000-4000-8000-000000000001';
--
-- (sms_click_event / sms_send_log rows created by a test run reference occurrences and must
-- be cleared first if a run has happened. That is the harness's cleanup, not this file's.)
-- ═══════════════════════════════════════════════════════════════════════════════════════════


-- ── 1. THE SOURCE ──────────────────────────────────────────────────────────────────────────
-- Named so that it is unmistakable in any table, any log line and any admin screen. It is also
-- the teardown key: every row in this file reaches it through series.source_id.
--
-- authority_tier = 'official' is not a claim about the fake data's provenance; it is the input
-- lib/search/postgres-repository.ts's confidence() reads, and 'official' + a last_checked_at
-- inside 7 days is what yields the `official_recent` label real ingested rows carry. Anything
-- lower would make every test listing render with a caveat no production listing would have.
--
-- terms_status / robots_status stay at their 'pending' defaults: this source is never fetched.
INSERT INTO source (id, family, name, authority_tier, ingestion_method, baseline_cadence)
VALUES (
  '5e000000-0000-4000-8000-000000000001',
  'testing_kf_sms_v2',
  'KF SMS v2 TEST CATALOGUE — SYNTHETIC, NOT A REAL SOURCE',
  'official', 'manual', '365 days'
)
ON CONFLICT (id) DO UPDATE SET
  family = EXCLUDED.family, name = EXCLUDED.name,
  authority_tier = EXCLUDED.authority_tier, ingestion_method = EXCLUDED.ingestion_method,
  baseline_cadence = EXCLUDED.baseline_cadence;


-- ── 2. VENUES ──────────────────────────────────────────────────────────────────────────────
-- Real facility names and real coordinates. The names matter: the weekly SMS prints the VENUE
-- name, and SMS copy is measured in septets against a 160-character segment, so testing the
-- message length against invented short names would test nothing.
--
-- geo and geo_authority are written TOGETHER because migration 0025 added
-- CHECK ((geo IS NULL) = (geo_authority IS NULL)) — writing geo alone fails the constraint.
-- Authority 0 is the lowest rung, the same value 0025's own backfill assigned to pre-existing
-- coordinates, and the honest one for a hand-entered point.
INSERT INTO venue (id, name, address, municipality_id, display_area, geo, geo_authority, geo_source, geo_set_at)
VALUES
  -- Vancouver (region 10000000-…-0010, centroid 49.2827 / -123.1207)
  ('5e100000-0000-4000-8000-000000000001', 'Hillcrest Community Centre', '4575 Clancy Loranger Way, Vancouver', '10000000-0000-0000-0000-000000000010', 'Vancouver', ST_SetSRID(ST_MakePoint(-123.1077, 49.2460), 4326)::geography, 0, 'kf-sms-v2-test-catalogue', now()),
  ('5e100000-0000-4000-8000-000000000002', 'Mount Pleasant Community Centre', '1 Kingsway, Vancouver', '10000000-0000-0000-0000-000000000010', 'Vancouver', ST_SetSRID(ST_MakePoint(-123.1000, 49.2637), 4326)::geography, 0, 'kf-sms-v2-test-catalogue', now()),
  ('5e100000-0000-4000-8000-000000000003', 'Kitsilano Community Centre', '2690 Larch St, Vancouver', '10000000-0000-0000-0000-000000000010', 'Vancouver', ST_SetSRID(ST_MakePoint(-123.1650, 49.2634), 4326)::geography, 0, 'kf-sms-v2-test-catalogue', now()),
  -- North Vancouver (region 10000000-…-0011, centroid 49.3163 / -123.0693)
  ('5e100000-0000-4000-8000-000000000004', 'Harry Jerome Community Recreation Centre', '123 E 23rd St, North Vancouver', '10000000-0000-0000-0000-000000000011', 'North Vancouver', ST_SetSRID(ST_MakePoint(-123.0704, 49.3234), 4326)::geography, 0, 'kf-sms-v2-test-catalogue', now()),
  ('5e100000-0000-4000-8000-000000000005', 'Delbrook Community Recreation Centre', '851 W Queens Rd, North Vancouver', '10000000-0000-0000-0000-000000000011', 'North Vancouver', ST_SetSRID(ST_MakePoint(-123.0885, 49.3352), 4326)::geography, 0, 'kf-sms-v2-test-catalogue', now()),
  ('5e100000-0000-4000-8000-000000000006', 'John Braithwaite Community Centre', '145 W 1st St, North Vancouver', '10000000-0000-0000-0000-000000000011', 'North Vancouver', ST_SetSRID(ST_MakePoint(-123.0805, 49.3113), 4326)::geography, 0, 'kf-sms-v2-test-catalogue', now()),
  -- West Vancouver (region 10000000-…-0012, centroid 49.3286 / -123.1591)
  ('5e100000-0000-4000-8000-000000000007', 'West Vancouver Community Centre', '2121 Marine Dr, West Vancouver', '10000000-0000-0000-0000-000000000012', 'West Vancouver', ST_SetSRID(ST_MakePoint(-123.1610, 49.3300), 4326)::geography, 0, 'kf-sms-v2-test-catalogue', now()),
  ('5e100000-0000-4000-8000-000000000008', 'West Vancouver Memorial Library', '1950 Marine Dr, West Vancouver', '10000000-0000-0000-0000-000000000012', 'West Vancouver', ST_SetSRID(ST_MakePoint(-123.1580, 49.3290), 4326)::geography, 0, 'kf-sms-v2-test-catalogue', now()),
  ('5e100000-0000-4000-8000-000000000009', 'Ambleside Park Field House', '1000 Argyle Ave, West Vancouver', '10000000-0000-0000-0000-000000000012', 'West Vancouver', ST_SetSRID(ST_MakePoint(-123.1560, 49.3245), 4326)::geography, 0, 'kf-sms-v2-test-catalogue', now()),
  -- Burnaby (region 10000000-…-0013, centroid 49.2488 / -122.9805)
  ('5e100000-0000-4000-8000-000000000010', 'Bonsor Recreation Complex', '6550 Bonsor Ave, Burnaby', '10000000-0000-0000-0000-000000000013', 'Burnaby', ST_SetSRID(ST_MakePoint(-123.0030, 49.2270), 4326)::geography, 0, 'kf-sms-v2-test-catalogue', now()),
  ('5e100000-0000-4000-8000-000000000011', 'Edmonds Community Centre', '7433 Edmonds St, Burnaby', '10000000-0000-0000-0000-000000000013', 'Burnaby', ST_SetSRID(ST_MakePoint(-122.9580, 49.2160), 4326)::geography, 0, 'kf-sms-v2-test-catalogue', now()),
  ('5e100000-0000-4000-8000-000000000012', 'Cameron Recreation Complex', '9523 Cameron St, Burnaby', '10000000-0000-0000-0000-000000000013', 'Burnaby', ST_SetSRID(ST_MakePoint(-122.8930, 49.2560), 4326)::geography, 0, 'kf-sms-v2-test-catalogue', now()),
  -- Richmond (region 10000000-…-0014, centroid 49.1666 / -123.1336)
  ('5e100000-0000-4000-8000-000000000013', 'Minoru Centre for Active Living', '7191 Granville Ave, Richmond', '10000000-0000-0000-0000-000000000014', 'Richmond', ST_SetSRID(ST_MakePoint(-123.1370, 49.1690), 4326)::geography, 0, 'kf-sms-v2-test-catalogue', now()),
  ('5e100000-0000-4000-8000-000000000014', 'Steveston Community Centre', '4111 Moncton St, Richmond', '10000000-0000-0000-0000-000000000014', 'Richmond', ST_SetSRID(ST_MakePoint(-123.1810, 49.1265), 4326)::geography, 0, 'kf-sms-v2-test-catalogue', now()),
  ('5e100000-0000-4000-8000-000000000015', 'South Arm Community Centre', '8880 Williams Rd, Richmond', '10000000-0000-0000-0000-000000000014', 'Richmond', ST_SetSRID(ST_MakePoint(-123.1130, 49.1480), 4326)::geography, 0, 'kf-sms-v2-test-catalogue', now())
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name, address = EXCLUDED.address,
  municipality_id = EXCLUDED.municipality_id, display_area = EXCLUDED.display_area,
  geo = EXCLUDED.geo, geo_authority = EXCLUDED.geo_authority,
  geo_source = EXCLUDED.geo_source, geo_set_at = EXCLUDED.geo_set_at;


-- ── 3. SERIES ──────────────────────────────────────────────────────────────────────────────
-- One per venue. The canonical title carries the TEST marker because nothing renders it to a
-- parent — the read model displays venue.name and only falls back to the series title when the
-- venue join is null, which cannot happen here. It IS indexed into search_tsv at weight C, and
-- being able to find every synthetic row with one search term is a feature, not a leak.
INSERT INTO activity_series (id, canonical_title, source_id, venue_id, season_state)
VALUES
  ('5e200000-0000-4000-8000-000000000001', 'KF-SMS-V2-TEST Hillcrest weekend drop-in',        '5e000000-0000-4000-8000-000000000001', '5e100000-0000-4000-8000-000000000001', 'active'),
  ('5e200000-0000-4000-8000-000000000002', 'KF-SMS-V2-TEST Mount Pleasant weekend drop-in',    '5e000000-0000-4000-8000-000000000001', '5e100000-0000-4000-8000-000000000002', 'active'),
  ('5e200000-0000-4000-8000-000000000003', 'KF-SMS-V2-TEST Kitsilano weekend drop-in',         '5e000000-0000-4000-8000-000000000001', '5e100000-0000-4000-8000-000000000003', 'active'),
  ('5e200000-0000-4000-8000-000000000004', 'KF-SMS-V2-TEST Harry Jerome weekend drop-in',      '5e000000-0000-4000-8000-000000000001', '5e100000-0000-4000-8000-000000000004', 'active'),
  ('5e200000-0000-4000-8000-000000000005', 'KF-SMS-V2-TEST Delbrook weekend drop-in',          '5e000000-0000-4000-8000-000000000001', '5e100000-0000-4000-8000-000000000005', 'active'),
  ('5e200000-0000-4000-8000-000000000006', 'KF-SMS-V2-TEST John Braithwaite weekend drop-in',  '5e000000-0000-4000-8000-000000000001', '5e100000-0000-4000-8000-000000000006', 'active'),
  ('5e200000-0000-4000-8000-000000000007', 'KF-SMS-V2-TEST West Van CC weekend drop-in',       '5e000000-0000-4000-8000-000000000001', '5e100000-0000-4000-8000-000000000007', 'active'),
  ('5e200000-0000-4000-8000-000000000008', 'KF-SMS-V2-TEST West Van Library weekend drop-in',  '5e000000-0000-4000-8000-000000000001', '5e100000-0000-4000-8000-000000000008', 'active'),
  ('5e200000-0000-4000-8000-000000000009', 'KF-SMS-V2-TEST Ambleside weekend drop-in',         '5e000000-0000-4000-8000-000000000001', '5e100000-0000-4000-8000-000000000009', 'active'),
  ('5e200000-0000-4000-8000-000000000010', 'KF-SMS-V2-TEST Bonsor weekend drop-in',            '5e000000-0000-4000-8000-000000000001', '5e100000-0000-4000-8000-000000000010', 'active'),
  ('5e200000-0000-4000-8000-000000000011', 'KF-SMS-V2-TEST Edmonds weekend drop-in',           '5e000000-0000-4000-8000-000000000001', '5e100000-0000-4000-8000-000000000011', 'active'),
  ('5e200000-0000-4000-8000-000000000012', 'KF-SMS-V2-TEST Cameron weekend drop-in',           '5e000000-0000-4000-8000-000000000001', '5e100000-0000-4000-8000-000000000012', 'active'),
  ('5e200000-0000-4000-8000-000000000013', 'KF-SMS-V2-TEST Minoru weekend drop-in',            '5e000000-0000-4000-8000-000000000001', '5e100000-0000-4000-8000-000000000013', 'active'),
  ('5e200000-0000-4000-8000-000000000014', 'KF-SMS-V2-TEST Steveston weekend drop-in',         '5e000000-0000-4000-8000-000000000001', '5e100000-0000-4000-8000-000000000014', 'active'),
  ('5e200000-0000-4000-8000-000000000015', 'KF-SMS-V2-TEST South Arm weekend drop-in',         '5e000000-0000-4000-8000-000000000001', '5e100000-0000-4000-8000-000000000015', 'active')
ON CONFLICT (id) DO UPDATE SET
  canonical_title = EXCLUDED.canonical_title, source_id = EXCLUDED.source_id,
  venue_id = EXCLUDED.venue_id, season_state = EXCLUDED.season_state;


-- ── 4/5. OCCURRENCES — 30 pickable + 4 negative controls ───────────────────────────────────
-- All 34 rows go through ONE statement so the weekend anchor is computed ONCE and cannot drift
-- between a "good" row and a control row. `day_offset` is days from that Saturday: 0 = Sat,
-- 1 = Sun, and -14 for the past-date control (the Saturday a fortnight before the anchor, which
-- lands 7–13 days ago whatever weekday the file is applied on, so it is unconditionally past).
--
-- THE FOUR CONTROLS ARE THE LAST FOUR ROWS AND THEY NAME THEMSELVES IN THEIR OWN TITLES:
--   ARCHIVED CONTROL — archived_at set. `visibleOccurrenceWhereSql()` drops it in SQL.
--   CANCELLED CONTROL — status_state 'cancelled', which is in HIDDEN_STATUSES.
--   PAST CONTROL     — ended a week ago. Excluded by the `COALESCE(end, start) >= now()` arm.
--   COURSE CONTROL   — visible in /search, but a multi-session commitment, so
--                      lib/sms/registration.ts::isWeeklyPickEligible must keep it out of a text.
-- If any of those four strings ever appears in a test SMS, the message says which gate failed.
--
-- `next_check_at` is left NULL DELIBERATELY: it is what the scheduler selects on, and synthetic
-- rows must never be picked up by a real job. `last_checked_at` is now() - 1 day so confidence()
-- returns `official_recent`, matching how a freshly-ingested production row renders.
--
-- registration_required is FALSE on the drop-in rows — under migration 0027 that is a POSITIVE
-- "just turn up" claim, not an absence, and it is the true statement about them. It is TRUE on
-- exactly two rows: the COURSE CONTROL, and West Van's 'Babytime Storytime' (a real library
-- shape — a one-off you must book). The second is there on purpose: Jon's §8 Q1 ruling says a
-- registration-flagged ONE-OFF must still be eligible for the weekly text, and that row is the
-- only thing in this catalogue that can prove the rule is implemented rather than assumed.
WITH anchor AS (
  SELECT (
    (
      date_trunc('day', now() AT TIME ZONE 'America/Vancouver')
      + ((((6 - EXTRACT(isodow FROM now() AT TIME ZONE 'America/Vancouver')::int + 6) % 7) + 1) * interval '1 day')
    ) AT TIME ZONE 'America/Vancouver'
  ) AS sat
),
v (id, series_id, activity_name, category_key, day_offset, start_time, duration,
   cost_status, cost_min, cost_max,
   registration_required, status_state, archived, description_snippet) AS (
  VALUES
    -- ── Vancouver ──────────────────────────────────────────────────────────────────────────
    ('5e300000-0000-4000-8000-000000000001'::uuid, '5e200000-0000-4000-8000-000000000001'::uuid, 'Family Swim',            'public_swim'::text, 0::int, interval '10 hours',          interval '90 minutes',  'free'::cost_status,  NULL::numeric, NULL::numeric, false, 'confirmed'::status_state, false, 'Everyone in the pool. Tots area open.'::text),
    ('5e300000-0000-4000-8000-000000000002', '5e200000-0000-4000-8000-000000000001', 'Parent & Tot Open Gym',  'open_gym',    1, interval '9 hours 30 minutes', interval '60 minutes',  'free',        NULL, NULL, false, 'confirmed', false, 'Soft mats, ride-on toys, no booking.'),
    ('5e300000-0000-4000-8000-000000000003', '5e200000-0000-4000-8000-000000000002', 'Family Storytime',       'storytime',   0, interval '11 hours',           interval '45 minutes',  'free',        NULL, NULL, false, 'confirmed', false, 'Songs, rhymes and picture books.'),
    ('5e300000-0000-4000-8000-000000000004', '5e200000-0000-4000-8000-000000000002', 'Open Gym: Ball Hockey',  'open_gym',    1, interval '13 hours',           interval '120 minutes', 'known',       3.00, 3.00, false, 'confirmed', false, 'Sticks provided. Helmet required.'),
    ('5e300000-0000-4000-8000-000000000005', '5e200000-0000-4000-8000-000000000003', 'Public Skate',           'skate',       0, interval '14 hours',           interval '105 minutes', 'known',       2.50, 5.00, false, 'confirmed', false, 'Skate rentals available on site.'),
    ('5e300000-0000-4000-8000-000000000006', '5e200000-0000-4000-8000-000000000003', 'Toddler Indoor Play',    'indoor_play', 1, interval '10 hours 30 minutes',interval '90 minutes',  'free',        NULL, NULL, false, 'confirmed', false, 'Gym set up for under-fives.'),
    -- ── North Vancouver ────────────────────────────────────────────────────────────────────
    ('5e300000-0000-4000-8000-000000000007', '5e200000-0000-4000-8000-000000000004', 'Family Swim',            'public_swim', 0, interval '9 hours',            interval '90 minutes',  'known',       3.50, 3.50, false, 'confirmed', false, 'Leisure pool, lazy river and tot pool.'),
    ('5e300000-0000-4000-8000-000000000008', '5e200000-0000-4000-8000-000000000004', 'Parent & Tot Play Time', 'indoor_play', 1, interval '10 hours',           interval '60 minutes',  'free',        NULL, NULL, false, 'confirmed', false, 'Unstructured play for the littlest ones.'),
    ('5e300000-0000-4000-8000-000000000009', '5e200000-0000-4000-8000-000000000005', 'Public Skate',           'skate',       0, interval '13 hours 30 minutes',interval '90 minutes',  'known',       2.00, 4.00, false, 'confirmed', false, 'Helmets required for under-twelves.'),
    ('5e300000-0000-4000-8000-000000000010', '5e200000-0000-4000-8000-000000000005', 'Open Gym: Basketball',   'open_gym',    1, interval '14 hours',           interval '120 minutes', 'known',       4.00, 4.00, false, 'confirmed', false, 'Half-court games, all abilities.'),
    ('5e300000-0000-4000-8000-000000000011', '5e200000-0000-4000-8000-000000000006', 'Family Storytime',       'storytime',   0, interval '10 hours 30 minutes',interval '45 minutes',  'free',        NULL, NULL, false, 'confirmed', false, 'Stories and a craft to take home.'),
    ('5e300000-0000-4000-8000-000000000012', '5e200000-0000-4000-8000-000000000006', 'Preschool Free Play',    'indoor_play', 1, interval '9 hours 30 minutes', interval '90 minutes',  'free',        NULL, NULL, false, 'confirmed', false, 'Drop in any time in the window.'),
    -- ── West Vancouver ─────────────────────────────────────────────────────────────────────
    ('5e300000-0000-4000-8000-000000000013', '5e200000-0000-4000-8000-000000000007', 'Family Swim',            'public_swim', 0, interval '10 hours',           interval '90 minutes',  'known',       3.00, 3.00, false, 'confirmed', false, 'Warm water pool and slide.'),
    ('5e300000-0000-4000-8000-000000000014', '5e200000-0000-4000-8000-000000000007', 'Open Gym: Badminton',    'open_gym',    1, interval '13 hours',           interval '120 minutes', 'known',       4.50, 4.50, false, 'confirmed', false, 'Racquets available to borrow.'),
    -- registration_required TRUE and NO drop_in tag — the booked one-off, see the note above.
    ('5e300000-0000-4000-8000-000000000015', '5e200000-0000-4000-8000-000000000008', 'Babytime Storytime',     'storytime',   0, interval '11 hours',           interval '30 minutes',  'free',        NULL, NULL, true,  'confirmed', false, 'Bounces and lap songs for babies.'),
    ('5e300000-0000-4000-8000-000000000016', '5e200000-0000-4000-8000-000000000008', 'Lego Drop-in Club',      'indoor_play', 1, interval '10 hours 30 minutes',interval '45 minutes',  'free',        NULL, NULL, false, 'confirmed', false, 'Bricks supplied. Build and leave it on display.'),
    ('5e300000-0000-4000-8000-000000000017', '5e200000-0000-4000-8000-000000000009', 'Family Nature Walk',     'outdoor_park',0, interval '13 hours',           interval '90 minutes',  'free',        NULL, NULL, false, 'confirmed', false, 'Easy seawall loop, strollers fine.'),
    ('5e300000-0000-4000-8000-000000000018', '5e200000-0000-4000-8000-000000000009', 'Toddler Park Play Time', 'outdoor_park',1, interval '10 hours',           interval '60 minutes',  'free',        NULL, NULL, false, 'confirmed', false, 'Sandpit and swings by the field house.'),
    -- ── Burnaby ────────────────────────────────────────────────────────────────────────────
    ('5e300000-0000-4000-8000-000000000019', '5e200000-0000-4000-8000-000000000010', 'Family Swim',            'public_swim', 0, interval '10 hours 30 minutes',interval '90 minutes',  'known',       3.25, 3.25, false, 'confirmed', false, 'Two pools open, tot pool included.'),
    ('5e300000-0000-4000-8000-000000000020', '5e200000-0000-4000-8000-000000000010', 'Parent & Tot Open Gym',  'open_gym',    1, interval '9 hours',            interval '60 minutes',  'free',        NULL, NULL, false, 'confirmed', false, 'Balls, hoops and tunnels.'),
    ('5e300000-0000-4000-8000-000000000021', '5e200000-0000-4000-8000-000000000011', 'Family Storytime',       'storytime',   0, interval '11 hours 30 minutes',interval '45 minutes',  'free',        NULL, NULL, false, 'confirmed', false, 'Bilingual stories, all welcome.'),
    ('5e300000-0000-4000-8000-000000000022', '5e200000-0000-4000-8000-000000000011', 'Open Gym: Volleyball',   'open_gym',    1, interval '13 hours 30 minutes',interval '120 minutes', 'known',       4.00, 4.00, false, 'confirmed', false, 'Nets up, teams made on the day.'),
    ('5e300000-0000-4000-8000-000000000023', '5e200000-0000-4000-8000-000000000012', 'Public Skate',           'skate',       0, interval '15 hours',           interval '105 minutes', 'known',       2.75, 5.50, false, 'confirmed', false, 'Music on. Rentals at the counter.'),
    ('5e300000-0000-4000-8000-000000000024', '5e200000-0000-4000-8000-000000000012', 'Toddler Indoor Play',    'indoor_play', 1, interval '10 hours',           interval '90 minutes',  'free',        NULL, NULL, false, 'confirmed', false, 'Ride-ons and a soft play zone.'),
    -- ── Richmond ───────────────────────────────────────────────────────────────────────────
    ('5e300000-0000-4000-8000-000000000025', '5e200000-0000-4000-8000-000000000013', 'Family Swim',            'public_swim', 0, interval '9 hours 30 minutes', interval '90 minutes',  'known',       3.00, 3.00, false, 'confirmed', false, 'Wave pool runs twice in the session.'),
    ('5e300000-0000-4000-8000-000000000026', '5e200000-0000-4000-8000-000000000013', 'Public Skate',           'skate',       1, interval '14 hours 30 minutes',interval '105 minutes', 'known',       2.50, 5.00, false, 'confirmed', false, 'Olympic oval ice, skate aids available.'),
    ('5e300000-0000-4000-8000-000000000027', '5e200000-0000-4000-8000-000000000014', 'Family Storytime',       'storytime',   0, interval '10 hours',           interval '45 minutes',  'free',        NULL, NULL, false, 'confirmed', false, 'Stories in the village hall room.'),
    ('5e300000-0000-4000-8000-000000000028', '5e200000-0000-4000-8000-000000000014', 'Waterfront Family Walk', 'outdoor_park',1, interval '11 hours',           interval '75 minutes',  'free',        NULL, NULL, false, 'confirmed', false, 'Boardwalk route past the cannery.'),
    ('5e300000-0000-4000-8000-000000000029', '5e200000-0000-4000-8000-000000000015', 'Open Gym: Ball Hockey',  'open_gym',    0, interval '13 hours',           interval '120 minutes', 'known',       3.50, 3.50, false, 'confirmed', false, 'Sticks provided, helmet required.'),
    ('5e300000-0000-4000-8000-000000000030', '5e200000-0000-4000-8000-000000000015', 'Toddler Indoor Play',    'indoor_play', 1, interval '9 hours 30 minutes', interval '90 minutes',  'free',        NULL, NULL, false, 'confirmed', false, 'Quiet corner for the under-twos.'),
    -- ── NEGATIVE CONTROLS — none of these four may ever reach a weekly text ─────────────────
    ('5e300000-0000-4000-8000-000000000031', '5e200000-0000-4000-8000-000000000001', 'Family Swim (ARCHIVED CONTROL)',                    'public_swim', 0, interval '10 hours', interval '90 minutes',  'free',  NULL, NULL, false, 'confirmed', true,  'Archived row. Must not appear anywhere.'),
    ('5e300000-0000-4000-8000-000000000032', '5e200000-0000-4000-8000-000000000002', 'Family Storytime (CANCELLED CONTROL)',              'storytime',   0, interval '11 hours', interval '45 minutes',  'free',  NULL, NULL, false, 'cancelled', false, 'Cancelled row. Hidden status.'),
    ('5e300000-0000-4000-8000-000000000033', '5e200000-0000-4000-8000-000000000003', 'Public Skate (PAST CONTROL)',                       'skate',     -14, interval '14 hours', interval '105 minutes', 'known', 2.50, 5.00, false, 'confirmed', false, 'Ended over a week ago. Outside the window.'),
    ('5e300000-0000-4000-8000-000000000034', '5e200000-0000-4000-8000-000000000004', 'Learn to Swim - 6 Week Lesson Set (COURSE CONTROL)', 'class_program',1,interval '9 hours', interval '45 minutes',  'known', 96.00, 96.00, true, 'confirmed', false, 'Multi-week course. Visible in search, never in a text.')
)
INSERT INTO activity_occurrence (
  id, series_id, activity_name, description_snippet, primary_category_id,
  start_datetime_utc, end_datetime_utc, cost_status, cost_min_cad, cost_max_cad,
  source_url, status_state, confidence_label, last_checked_at, next_check_at,
  archived_at, registration_required, source_title
)
SELECT
  v.id, v.series_id, v.activity_name, v.description_snippet,
  (SELECT c.id FROM category c WHERE c.key = v.category_key),
  a.sat + (v.day_offset * interval '1 day') + v.start_time,
  a.sat + (v.day_offset * interval '1 day') + v.start_time + v.duration,
  v.cost_status, v.cost_min, v.cost_max,
  -- .invalid is reserved by RFC 2606 and can never resolve. A synthetic row must not be able
  -- to send a tester to a real page that says something different from what the row claims.
  'https://kf-sms-v2-test.invalid/occurrence/' || v.id::text,
  v.status_state, 'high',
  now() - interval '1 day',
  NULL,
  CASE WHEN v.archived THEN now() - interval '1 hour' ELSE NULL END,
  v.registration_required,
  v.activity_name
FROM v CROSS JOIN anchor a
ON CONFLICT (id) DO UPDATE SET
  series_id = EXCLUDED.series_id, activity_name = EXCLUDED.activity_name,
  description_snippet = EXCLUDED.description_snippet,
  primary_category_id = EXCLUDED.primary_category_id,
  start_datetime_utc = EXCLUDED.start_datetime_utc,
  end_datetime_utc = EXCLUDED.end_datetime_utc,
  cost_status = EXCLUDED.cost_status, cost_min_cad = EXCLUDED.cost_min_cad,
  cost_max_cad = EXCLUDED.cost_max_cad, source_url = EXCLUDED.source_url,
  status_state = EXCLUDED.status_state, confidence_label = EXCLUDED.confidence_label,
  last_checked_at = EXCLUDED.last_checked_at, next_check_at = EXCLUDED.next_check_at,
  archived_at = EXCLUDED.archived_at,
  registration_required = EXCLUDED.registration_required,
  source_title = EXCLUDED.source_title;


-- ── 6. AGES ────────────────────────────────────────────────────────────────────────────────
-- This is the ONLY place an age appears in this file, so the bounds and the bands can never
-- disagree — `age_band_matches` is DERIVED from the bounds by the overlap rule (a band matches
-- when its half-open range intersects the listing's), not hand-listed beside them. That also
-- means it re-derives correctly if age_band's own rows are ever re-seeded.
--
-- age_min_months is NOT optional decoration: lib/recommend/three-things.ts::isShowableOnFrontDoor
-- — which lib/sms/weekly-picks.ts imports rather than restating — rejects any listing whose
-- source never stated an age. A row here without an occurrence_age row would be loaded, ranked,
-- and then silently dropped from every text, which is a very confusing thing to debug.
--
-- age_notes stays NULL on every row. lib/search/filters/audience.ts reads it for adult-audience
-- wording, and an invented note is a claim about a source that does not exist.
INSERT INTO occurrence_age (occurrence_id, age_min_months, age_max_months, age_band_matches, age_notes)
SELECT
  v.occurrence_id, v.age_min_months, v.age_max_months,
  ARRAY(
    SELECT b.id FROM age_band b
    WHERE b.lower_months_inclusive < v.age_max_months
      AND (b.upper_months_exclusive IS NULL OR b.upper_months_exclusive > v.age_min_months)
    ORDER BY b.lower_months_inclusive
  ),
  NULL
FROM (VALUES
  ('5e300000-0000-4000-8000-000000000001'::uuid,  0::int, 144::int),
  ('5e300000-0000-4000-8000-000000000002',   6,  48),
  ('5e300000-0000-4000-8000-000000000003',   0,  60),
  ('5e300000-0000-4000-8000-000000000004',  72, 168),
  ('5e300000-0000-4000-8000-000000000005',  36, 192),
  ('5e300000-0000-4000-8000-000000000006',  12,  60),
  ('5e300000-0000-4000-8000-000000000007',   0, 144),
  ('5e300000-0000-4000-8000-000000000008',   6,  48),
  ('5e300000-0000-4000-8000-000000000009',  36, 192),
  ('5e300000-0000-4000-8000-000000000010',  72, 168),
  ('5e300000-0000-4000-8000-000000000011',   0,  60),
  ('5e300000-0000-4000-8000-000000000012',  12,  60),
  ('5e300000-0000-4000-8000-000000000013',   0, 144),
  ('5e300000-0000-4000-8000-000000000014',  72, 168),
  ('5e300000-0000-4000-8000-000000000015',   0,  24),
  ('5e300000-0000-4000-8000-000000000016',  60, 144),
  ('5e300000-0000-4000-8000-000000000017',  24, 168),
  ('5e300000-0000-4000-8000-000000000018',  12,  60),
  ('5e300000-0000-4000-8000-000000000019',   0, 144),
  ('5e300000-0000-4000-8000-000000000020',   6,  48),
  ('5e300000-0000-4000-8000-000000000021',   0,  60),
  ('5e300000-0000-4000-8000-000000000022',  72, 168),
  ('5e300000-0000-4000-8000-000000000023',  36, 192),
  ('5e300000-0000-4000-8000-000000000024',  12,  60),
  ('5e300000-0000-4000-8000-000000000025',   0, 144),
  ('5e300000-0000-4000-8000-000000000026',  36, 192),
  ('5e300000-0000-4000-8000-000000000027',   0,  60),
  ('5e300000-0000-4000-8000-000000000028',  24, 168),
  ('5e300000-0000-4000-8000-000000000029',  72, 168),
  ('5e300000-0000-4000-8000-000000000030',  12,  60),
  -- controls
  ('5e300000-0000-4000-8000-000000000031',   0, 144),
  ('5e300000-0000-4000-8000-000000000032',   0,  60),
  ('5e300000-0000-4000-8000-000000000033',  36, 192),
  ('5e300000-0000-4000-8000-000000000034',  36,  96)
) AS v(occurrence_id, age_min_months, age_max_months)
ON CONFLICT (occurrence_id) DO UPDATE SET
  age_min_months = EXCLUDED.age_min_months,
  age_max_months = EXCLUDED.age_max_months,
  age_band_matches = EXCLUDED.age_band_matches,
  age_notes = EXCLUDED.age_notes;


-- ── 7. TAGS ────────────────────────────────────────────────────────────────────────────────
-- `tag_type` is read off the tag row itself rather than restated per line, so it cannot
-- contradict the CHECK constraint in migration 0005 or drift from supabase/seeds/categories_tags.sql.
--
-- `drop_in` IS THE LOAD-BEARING ONE. lib/search/filters/registration.ts treats a drop-in signal
-- as an absolute veto over every registration signal, so the tag — not the title — is what keeps
-- these rows in the default view and eligible for a text. The two rows that deliberately lack it
-- are 'Babytime Storytime' (a booked one-off, which must STILL be eligible) and the COURSE
-- CONTROL (which must not be).
--
-- ON CONFLICT DO NOTHING against the partial unique index: re-running must not multiply rows,
-- and there is nothing to update — the row is the association.
INSERT INTO occurrence_category_tag (occurrence_id, tag_id, tag_type)
SELECT v.occurrence_id, t.id, t.tag_type
FROM (VALUES
  ('5e300000-0000-4000-8000-000000000001'::uuid, ARRAY['drop_in','free','indoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000002', ARRAY['drop_in','free','indoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000003', ARRAY['drop_in','free','indoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000004', ARRAY['drop_in','indoor']),
  ('5e300000-0000-4000-8000-000000000005', ARRAY['drop_in','indoor']),
  ('5e300000-0000-4000-8000-000000000006', ARRAY['drop_in','free','indoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000007', ARRAY['drop_in','indoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000008', ARRAY['drop_in','free','indoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000009', ARRAY['drop_in','indoor']),
  ('5e300000-0000-4000-8000-000000000010', ARRAY['drop_in','indoor']),
  ('5e300000-0000-4000-8000-000000000011', ARRAY['drop_in','free','indoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000012', ARRAY['drop_in','free','indoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000013', ARRAY['drop_in','indoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000014', ARRAY['drop_in','indoor']),
  -- no drop_in: the booked one-off. See the note above.
  ('5e300000-0000-4000-8000-000000000015', ARRAY['free','indoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000016', ARRAY['drop_in','free','indoor']),
  ('5e300000-0000-4000-8000-000000000017', ARRAY['drop_in','free','outdoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000018', ARRAY['drop_in','free','outdoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000019', ARRAY['drop_in','indoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000020', ARRAY['drop_in','free','indoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000021', ARRAY['drop_in','free','indoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000022', ARRAY['drop_in','indoor']),
  ('5e300000-0000-4000-8000-000000000023', ARRAY['drop_in','indoor']),
  ('5e300000-0000-4000-8000-000000000024', ARRAY['drop_in','free','indoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000025', ARRAY['drop_in','indoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000026', ARRAY['drop_in','indoor']),
  ('5e300000-0000-4000-8000-000000000027', ARRAY['drop_in','free','indoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000028', ARRAY['drop_in','free','outdoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000029', ARRAY['drop_in','indoor']),
  ('5e300000-0000-4000-8000-000000000030', ARRAY['drop_in','free','indoor','stroller_friendly']),
  -- controls
  ('5e300000-0000-4000-8000-000000000031', ARRAY['drop_in','free','indoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000032', ARRAY['drop_in','free','indoor','stroller_friendly']),
  ('5e300000-0000-4000-8000-000000000033', ARRAY['drop_in','indoor']),
  -- no drop_in: the COURSE CONTROL must stay registration-shaped.
  ('5e300000-0000-4000-8000-000000000034', ARRAY['indoor'])
) AS v(occurrence_id, tag_keys)
JOIN tag t ON t.key = ANY(v.tag_keys)
ON CONFLICT (occurrence_id, tag_id) WHERE tag_id IS NOT NULL DO NOTHING;


-- ── 8. WHAT JUST HAPPENED ──────────────────────────────────────────────────────────────────
-- Printed so the apply is self-verifying: the numbers below are the ones to check, not the
-- absence of an error. Expect 6 pickable per municipality and the four controls accounted for.
SELECT
  COALESCE(r.name, '(control / no municipality)') AS municipality,
  count(*) FILTER (
    WHERE o.archived_at IS NULL
      AND o.status_state = 'confirmed'
      AND o.start_datetime_utc > now()
      AND o.activity_name NOT LIKE '%CONTROL)'
  ) AS pickable,
  count(*) FILTER (WHERE o.activity_name LIKE '%CONTROL)') AS controls,
  count(*) AS total,
  min(o.start_datetime_utc) AT TIME ZONE 'America/Vancouver' AS earliest_local,
  max(o.start_datetime_utc) AT TIME ZONE 'America/Vancouver' AS latest_local
FROM activity_occurrence o
JOIN activity_series s ON s.id = o.series_id
LEFT JOIN venue v ON v.id = s.venue_id
LEFT JOIN region r ON r.id = v.municipality_id
WHERE s.source_id = '5e000000-0000-4000-8000-000000000001'
GROUP BY ROLLUP (r.name)
ORDER BY r.name NULLS LAST;
