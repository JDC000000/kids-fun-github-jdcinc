-- scripts/snapshot/synthetic-production.sql
--
-- ⚠️  LOCAL / TEST ONLY. Never apply this to a real database. Every value here is fabricated.
--
-- WHY THIS FILE EXISTS
-- The snapshot tooling must be provable WITHOUT production access — nobody should have to
-- point export.sh at a real database to find out whether the scrub works. This builds a local
-- database shaped like production and then attacks the tooling with it:
--
--   1. CANARIES IN THE EXCLUDED TABLES. Every user/account/ops table gets rows whose values
--      contain the literal token `CANARY` — real-looking children's ages, a Google identity, a
--      saved search, an admin audit entry, an analytics event, a correction report, an
--      organisation contact. If `CANARY` appears anywhere in an exported snapshot, the
--      allowlist has failed. That is a grep, not an argument.
--
--   2. REALISTIC PII PLANTED IN THE CATALOGUE'S FREE TEXT. Scraped descriptions really do
--      carry "call 604-555-0123" and "email jane@…". Each planted value is realistic enough to
--      exercise the detectors AND contains `canary` so its removal can be proven by grep.
--
--   3. AWKWARD SHAPES the fixtures do not have: microsecond timestamps, non-UTC-looking
--      offsets, open-hours rows with no start time, null vs false registration_required,
--      open-ended age bands, a venue with no geo, phones in four different formats, an
--      apostrophe and a unicode dash in a title, a NULL parent region.
--
-- Apply AFTER scripts/local-db-bootstrap.sh and scripts/seed.sh. Idempotent-ish: it deletes
-- the rows it owns (family/name prefixed `synthprod`) before re-inserting.
BEGIN;

-- ── clean up a previous run ──────────────────────────────────────────────────────────
DELETE FROM provenance      WHERE occurrence_id IN (SELECT o.id FROM activity_occurrence o JOIN activity_series s ON s.id = o.series_id JOIN source src ON src.id = s.source_id WHERE src.family LIKE 'synthprod%');
DELETE FROM occurrence_category_tag WHERE occurrence_id IN (SELECT o.id FROM activity_occurrence o JOIN activity_series s ON s.id = o.series_id JOIN source src ON src.id = s.source_id WHERE src.family LIKE 'synthprod%');
DELETE FROM occurrence_age  WHERE occurrence_id IN (SELECT o.id FROM activity_occurrence o JOIN activity_series s ON s.id = o.series_id JOIN source src ON src.id = s.source_id WHERE src.family LIKE 'synthprod%');
DELETE FROM analytics_event WHERE event_type LIKE 'CANARY%';
DELETE FROM correction_report WHERE issue_type LIKE 'CANARY%';
DELETE FROM activity_occurrence WHERE series_id IN (SELECT s.id FROM activity_series s JOIN source src ON src.id = s.source_id WHERE src.family LIKE 'synthprod%');
DELETE FROM activity_series  WHERE source_id IN (SELECT id FROM source WHERE family LIKE 'synthprod%');
DELETE FROM source           WHERE family LIKE 'synthprod%';
DELETE FROM venue            WHERE name LIKE 'Synthprod %';
DELETE FROM admin_audit_log  WHERE action LIKE 'CANARY%';
DELETE FROM admin_user       WHERE user_id IN (SELECT id FROM user_profile WHERE google_identity LIKE '%CANARY%');
DELETE FROM weekly_email_send WHERE resend_id LIKE 'CANARY%';
DELETE FROM saved_search     WHERE query_json::text LIKE '%CANARY%';
DELETE FROM user_profile     WHERE google_identity LIKE '%CANARY%';
DELETE FROM organisation     WHERE name LIKE 'CANARY%';
DELETE FROM region           WHERE name LIKE 'Synthprod %';

-- ═════════════════════════════════════════════════════════════════════════════════════
-- EXCLUDED TABLES — the canaries. None of this may ever reach a snapshot file.
-- ═════════════════════════════════════════════════════════════════════════════════════

-- Children's ages + a Google identity: the two columns scripts/pipeda-cleanup/ exists to clear.
INSERT INTO user_profile (id, google_identity, home_postal, saved_child_ages, email_opt_in, home_geo) VALUES
  ('11111111-1111-4111-8111-111111111111', 'CANARY.parent.one@gmail.example', 'V6B 1A1', '{18,54,97}', true,  ST_SetSRID(ST_MakePoint(-123.1207, 49.2827), 4326)::geography),
  ('22222222-2222-4222-8222-222222222222', 'CANARY.parent.two@gmail.example', 'V5K 0A1', '{7,7,132}',   false, ST_SetSRID(ST_MakePoint(-123.0230, 49.2819), 4326)::geography);

INSERT INTO saved_search (id, user_id, query_json) VALUES
  ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111',
   '{"q":"CANARY swimming near my house","ages":[18,54],"area":"Mount Pleasant"}'::jsonb);

INSERT INTO admin_user (user_id, role) VALUES ('22222222-2222-4222-8222-222222222222', 'admin');
INSERT INTO admin_audit_log (admin_user_id, action, target_table, target_id, before_json, after_json) VALUES
  ('22222222-2222-4222-8222-222222222222', 'CANARY_update_source', 'source', NULL,
   '{"terms_status":"pending","note":"CANARY before"}'::jsonb, '{"terms_status":"allowed","note":"CANARY after"}'::jsonb);

INSERT INTO weekly_email_send (user_id, activity_count, resend_id, dry_run) VALUES
  ('11111111-1111-4111-8111-111111111111', 12, 'CANARY-resend-abc123', false);

INSERT INTO analytics_event (event_type, search_context_json, user_or_session, retained_until) VALUES
  ('CANARY_search', '{"q":"CANARY toddler swim","postal":"V6B 1A1"}'::jsonb, 'CANARY-session-9f2a', now() + interval '13 months');

INSERT INTO organisation (name, type, website, contact, source_family) VALUES
  ('CANARY Little Sprouts Home Daycare', 'private', 'https://example.org/canary', 'CANARY Priya Raman, 604-555-0142, priya.canary@example.org', 'synthprod_manual');

-- ═════════════════════════════════════════════════════════════════════════════════════
-- CATALOGUE — allowlisted tables, with realistic planted PII in the free-text columns.
-- ═════════════════════════════════════════════════════════════════════════════════════

-- Regions.
--
-- Deliberately only sub_areas, hung off the SEEDED municipalities (supabase/seeds/regions.sql)
-- rather than inventing new ones. A loaded snapshot REPLACES the region table wholesale, and
-- tests/admin/data-health-db.test.ts asserts the municipality set equals the LAUNCH_REGIONS
-- constant — so a synthetic dataset that invents municipalities makes that suite fail for a
-- reason that has nothing to do with production and drowns out the findings that matter.
-- Real production regions ARE the seeded launch regions, so this mirrors production.
--
-- The metro → municipality → sub_area → sub_area chain still exercises the loader's self-FK
-- second pass, which is the structural thing that needed proving.
INSERT INTO region (id, name, level, parent_id, centroid) VALUES
  ('aaaa0000-0000-4000-8000-000000000004', 'Synthprod Mount Pleasant', 'sub_area',
   (SELECT id FROM region WHERE name = 'Vancouver' AND level = 'municipality'),
   ST_SetSRID(ST_MakePoint(-123.1000, 49.2640), 4326)::geography),
  ('aaaa0000-0000-4000-8000-000000000006', 'Synthprod Brentwood', 'sub_area',
   (SELECT id FROM region WHERE name = 'Burnaby' AND level = 'municipality'),
   ST_SetSRID(ST_MakePoint(-122.9990, 49.2660), 4326)::geography),
  -- A sub_area nested under another sub_area: three loaded levels of self-reference.
  ('aaaa0000-0000-4000-8000-000000000007', 'Synthprod Main Street', 'sub_area',
   'aaaa0000-0000-4000-8000-000000000004',
   ST_SetSRID(ST_MakePoint(-123.1010, 49.2610), 4326)::geography);
-- A deliberately BROKEN row lives in synthetic-production-defect.sql, applied separately, so
-- that the default synthetic dataset is clean and `npm run test:snapshot` is green out of the
-- box. Apply the defect file to watch the shape suite catch a real data defect.

-- Sources. terms_status 'allowed' where confirmed occurrences hang off them (migration 0021).
INSERT INTO source (id, family, name, authority_tier, terms_status, robots_status, platform,
                    publication_horizon, baseline_cadence, near_date_cadence, season_state,
                    health_state, ingestion_method, last_check_at, next_check_at,
                    robots_override_decision, robots_override_note) VALUES
  ('bbbb0000-0000-4000-8000-000000000001', 'synthprod_library', 'Synthprod Public Library', 'official', 'allowed', 'allowed', 'BiblioCommons',
   '90 days', '1 day', '6 hours', 'active', 'healthy', 'auto',
   '2026-08-17 22:14:31.482913+00', '2026-08-18 04:14:31.482913+00', NULL, NULL),
  -- robots_status 'unknown', not 'disallowed': the 0022 CHECK forbids an override on a
  -- disallowed source, and 'unknown' is the state an override actually exists to resolve.
  ('bbbb0000-0000-4000-8000-000000000002', 'synthprod_rec', 'Synthprod Parks & Rec', 'official', 'allowed', 'unknown', 'ActiveNet',
   '120 days', '1 day', '12 hours', 'in_season', 'degraded', 'semi',
   '2026-08-17 19:02:07.000001+00', '2026-08-18 07:02:07.000001+00',
   'allow_with_attribution',
   -- Operator prose naming a real person at the municipality: exactly what placeholder_token exists for.
   'CANARY: emailed Dana Whitfield (dana.canary@example.org, 604-555-0177) at the City on 2026-07-02; she confirmed the crawl is fine.'),
  ('bbbb0000-0000-4000-8000-000000000003', 'synthprod_museum', 'Synthprod Science Museum', 'editorial', 'summarise_only', 'unknown', NULL,
   NULL, '7 days', NULL, 'unknown', 'unknown', 'manual', NULL, NULL, NULL, NULL);

-- Venues. Four phone formats, an address with a postal code (kept, deliberately), scraped
-- accessibility prose with planted contacts, and one venue with no geo at all.
INSERT INTO venue (id, name, address, municipality_id, neighbourhood, display_area,
                   accessibility_notes, official_url, geo, phone,
                   geo_authority, geo_source, geo_attribution, geo_set_at) VALUES
  ('cccc0000-0000-4000-8000-000000000001', 'Synthprod Mount Pleasant Branch',
   '1 Kingsway, Vancouver, BC V5T 3H7', (SELECT id FROM region WHERE name = 'Vancouver' AND level = 'municipality'), 'Mount Pleasant', 'Vancouver — East',
   'Step-free entrance on the north side. For a quieter session please contact Amelia Novak at amelia.canary@example.org or call 604-555-0123 ext 22.',
   'https://example.org/synthprod/mp-branch', ST_SetSRID(ST_MakePoint(-123.1005, 49.2625), 4326)::geography,
   '(604) 555-0123', 1, 'municipal_open_data', 'City of Synthprod, Open Government Licence', '2026-05-02 11:00:00+00'),
  ('cccc0000-0000-4000-8000-000000000002', 'Synthprod Burnaby Aquatic Centre',
   '4949 Canada Way, Burnaby, BC V5G 1M2', (SELECT id FROM region WHERE name = 'Burnaby' AND level = 'municipality'), 'Brentwood', 'Burnaby',
   'Pool lift available. Family change rooms.',
   'https://example.org/synthprod/aquatic', ST_SetSRID(ST_MakePoint(-122.9930, 49.2480), 4326)::geography,
   '604-555-0198', 2, 'geocoded_mapbox', 'Mapbox', '2026-06-11 08:30:00.5+00'),
  ('cccc0000-0000-4000-8000-000000000003', 'Synthprod Science Museum',
   '1455 Quebec St, Vancouver, BC V6A 3Z7', (SELECT id FROM region WHERE name = 'Vancouver' AND level = 'municipality'), 'False Creek', 'Vancouver — Central',
   'All galleries wheelchair accessible.',
   -- Credentials smuggled into a scraped URL — the redact_contact specimen.
   'https://synthprod-ops:hunter2@example.org/museum', ST_SetSRID(ST_MakePoint(-123.1039, 49.2734), 4326)::geography,
   -- geo_* are all paired because 0025's venue_geo_authority_paired CHECK requires it once geo is set.
   '+1 604 555 0164', 3, 'operator_manual', 'Synthprod Science Museum', '2026-04-01 00:00:00+00'),
  -- No geo, no phone, no address: the null-shape specimen the fixtures never produce.
  ('cccc0000-0000-4000-8000-000000000004', 'Synthprod Pop-Up Storytime Tent',
   NULL, 'aaaa0000-0000-4000-8000-000000000004', NULL, 'Vancouver — East',
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);

-- Series. One title carries an apostrophe and an en dash; one has an RRULE.
INSERT INTO activity_series (id, canonical_title, recurrence_rule, source_id, venue_id, season_state, default_primary_category, default_tags) VALUES
  ('dddd0000-0000-4000-8000-000000000001', 'Family Storytime — Mount Pleasant', 'FREQ=WEEKLY;BYDAY=SA', 'bbbb0000-0000-4000-8000-000000000001', 'cccc0000-0000-4000-8000-000000000001', 'active',
   (SELECT id FROM category WHERE key = 'storytime' LIMIT 1), '{}'),
  ('dddd0000-0000-4000-8000-000000000002', 'Parent & Tot Swim (register with Coach Mira Halvorsen, mira.canary@example.org)', NULL, 'bbbb0000-0000-4000-8000-000000000002', 'cccc0000-0000-4000-8000-000000000002', 'in_season',
   NULL, '{}'),
  ('dddd0000-0000-4000-8000-000000000003', 'Museum Open Hours', NULL, 'bbbb0000-0000-4000-8000-000000000003', 'cccc0000-0000-4000-8000-000000000003', 'active', NULL, '{}'),
  ('dddd0000-0000-4000-8000-000000000004', 'Pop-Up Storytime in the Park', 'FREQ=WEEKLY;BYDAY=SU', 'bbbb0000-0000-4000-8000-000000000001', 'cccc0000-0000-4000-8000-000000000004', 'active',
   (SELECT id FROM category WHERE key = 'storytime' LIMIT 1), '{}');

-- Hand-crafted adversarial occurrences.
INSERT INTO activity_occurrence (id, series_id, activity_name, description_snippet, primary_category_id,
                                 start_datetime_utc, end_datetime_utc, open_hours_state,
                                 cost_min_cad, cost_max_cad, cost_status, source_url, booking_url, location_url,
                                 status_state, confidence_label, last_checked_at, next_check_at, archived_at,
                                 source_record_id, dedup_key, registration_required) VALUES
  -- Microsecond precision + a non-zero offset in the literal: the exact fidelity a Date-based
  -- codec would silently round away.
  ('eeee0000-0000-4000-8000-000000000001', 'dddd0000-0000-4000-8000-000000000001', 'Family Storytime',
   'Songs, rhymes and stories for ages 0-5. Drop in, no registration. Questions? Contact Amelia Novak at amelia.canary@example.org or 604-555-0123. Accessible entrance at V5T 3H7.',
   (SELECT id FROM category WHERE key = 'storytime' LIMIT 1),
   '2026-09-19 10:30:00.123456-07', '2026-09-19 11:15:00.123456-07', NULL,
   NULL, NULL, 'free', 'https://example.org/synthprod/events/storytime-0919', NULL, NULL,
   'confirmed', 'high', '2026-08-17 22:14:31.482913+00', '2026-08-18 22:14:31.482913+00', NULL,
   'synthprod-lib-0919', 'synthprod|storytime|mp|2026-09-19T17:30Z', false),
  -- registration_required NULL (unstated) — distinct from false, and rendered differently.
  ('eeee0000-0000-4000-8000-000000000002', 'dddd0000-0000-4000-8000-000000000002', 'Parent & Tot Swim',
   'Caregiver-in-water lesson. Register online or call the front desk at 6045550198. Instructor Mira Halvorsen (mira.canary@example.org).',
   NULL,
   '2026-09-21 16:00:00+00', '2026-09-21 16:45:00+00', NULL,
   6.55, 9.10, 'known', 'https://example.org/synthprod/rec/swim-0921', 'https://example.org/synthprod/book/swim-0921', 'https://maps.example.org/?q=49.248,-122.993',
   'bookable_open', 'medium', '2026-08-17 19:02:07.000001+00', NULL, NULL,
   'synthprod-rec-0921', 'synthprod|swim|bby|2026-09-21T16:00Z', NULL),
  -- Open-hours row: NO start time at all. Exercises the CHECK and the dateless render path.
  ('eeee0000-0000-4000-8000-000000000003', 'dddd0000-0000-4000-8000-000000000003', 'Science Museum — All Galleries',
   'Hands-on exhibits for all ages. Group bookings: groups.canary@example.org.',
   NULL,
   NULL, NULL, 'Daily 10:00 AM–5:00 PM',
   29.00, 29.00, 'known', 'https://example.org/synthprod/museum/visit', NULL, NULL,
   'confirmed', 'medium', '2026-08-16 12:00:00+00', NULL, NULL,
   'synthprod-mus-open', 'synthprod|museum|open-hours', true),
  -- Soft-deleted + stale: visibility predicates must still see the right shape.
  ('eeee0000-0000-4000-8000-000000000004', 'dddd0000-0000-4000-8000-000000000004', 'Pop-Up Storytime in the Park',
   'Weather permitting. Cancelled sessions are announced on the branch line, 604.555.0123.',
   (SELECT id FROM category WHERE key = 'storytime' LIMIT 1),
   '2026-07-05 17:00:00+00', '2026-07-05 17:45:00+00', NULL,
   NULL, NULL, 'unknown', 'https://example.org/synthprod/events/popup-0705', NULL, NULL,
   'stale', 'low', '2026-07-06 03:00:00+00', NULL, '2026-07-20 00:00:00+00',
   'synthprod-lib-0705', 'synthprod|storytime|park|2026-07-05T17:00Z', false);

-- Volume. 600 occurrences across the two confirmed-capable series so the round trip is
-- measured on something with real cardinality rather than four rows.
INSERT INTO activity_occurrence (series_id, activity_name, description_snippet, primary_category_id,
                                 start_datetime_utc, end_datetime_utc, cost_min_cad, cost_max_cad, cost_status,
                                 source_url, status_state, confidence_label, last_checked_at,
                                 source_record_id, dedup_key, registration_required)
SELECT
  CASE WHEN g % 2 = 0 THEN 'dddd0000-0000-4000-8000-000000000001'::uuid ELSE 'dddd0000-0000-4000-8000-000000000002'::uuid END,
  CASE WHEN g % 2 = 0 THEN 'Family Storytime' ELSE 'Parent & Tot Swim' END,
  CASE WHEN g % 7 = 0
       THEN 'Drop-in session. For accessibility questions email access.canary@example.org or call 604-555-0' || lpad((100 + (g % 90))::text, 3, '0') || '.'
       ELSE 'Weekly session for families. All materials provided.' END,
  CASE WHEN g % 2 = 0 THEN (SELECT id FROM category WHERE key = 'storytime' LIMIT 1) ELSE NULL END,
  timestamptz '2026-09-01 17:30:00+00' + (g || ' hours')::interval + ((g % 1000) || ' microseconds')::interval,
  timestamptz '2026-09-01 18:15:00+00' + (g || ' hours')::interval + ((g % 1000) || ' microseconds')::interval,
  CASE WHEN g % 3 = 0 THEN NULL ELSE round((g % 25)::numeric + 0.55, 2) END,
  CASE WHEN g % 3 = 0 THEN NULL ELSE round((g % 25)::numeric + 4.05, 2) END,
  -- cost_status agrees with the numbers: 'known' ONLY where a price is actually present.
  -- Rows with no price cycle through the three honest not-a-price states.
  CASE WHEN g % 3 = 0
       THEN (ARRAY['free','unknown','check_source']::cost_status[])[1 + ((g / 3) % 3)]
       ELSE 'known'::cost_status END,
  'https://example.org/synthprod/events/bulk-' || g,
  (ARRAY['confirmed','bookable_open','needs_review','seasonal_active','not_yet_bookable']::status_state[])[1 + (g % 5)],
  (ARRAY['unscored','low','medium','high'])[1 + (g % 4)],
  timestamptz '2026-08-17 00:00:00+00' + (g || ' minutes')::interval,
  'synthprod-bulk-' || g,
  'synthprod|bulk|' || g,
  CASE WHEN g % 3 = 0 THEN NULL WHEN g % 3 = 1 THEN true ELSE false END
FROM generate_series(1, 600) AS g;

-- Age suitability. NOTE: this is the age range OF A PUBLIC PROGRAM, not any child's age.
WITH occ AS (
  SELECT o.id, row_number() OVER (ORDER BY o.id) AS rn
  FROM activity_occurrence o
  JOIN activity_series s ON s.id = o.series_id
  JOIN source src ON src.id = s.source_id
  WHERE src.family LIKE 'synthprod%'
), banded AS (
  SELECT id, rn,
         ARRAY(SELECT b.id FROM age_band b ORDER BY b.lower_months_inclusive LIMIT (1 + (occ.rn % 3))) AS bands
  FROM occ
)
INSERT INTO occurrence_age (occurrence_id, age_min_months, age_max_months, age_band_matches, age_notes)
SELECT banded.id,
       CASE WHEN rn % 4 = 0 THEN NULL ELSE (rn % 60)::int END,
       CASE WHEN rn % 5 = 0 THEN NULL ELSE 60 + (rn % 120)::int END,
       bands,
       CASE WHEN rn % 11 = 0
            THEN 'Ages 5-9. Older siblings welcome — ask for Priya Raman at the desk, or 604-555-0142.'
            ELSE NULL END
FROM banded;

-- Open-ended band specimen: max NULL means "15+ and up", the case that breaks naive mappers.
UPDATE occurrence_age SET age_min_months = 180, age_max_months = NULL
 WHERE occurrence_id = 'eeee0000-0000-4000-8000-000000000003';

-- Tag joins (fires the 0010 reindex trigger on the way in, both here and on load).
INSERT INTO occurrence_category_tag (occurrence_id, tag_id, tag_type)
SELECT o.id, t.id, t.tag_type
FROM activity_occurrence o
JOIN activity_series s ON s.id = o.series_id
JOIN source src ON src.id = s.source_id
JOIN LATERAL (SELECT id, tag_type FROM tag ORDER BY key LIMIT 2) t ON true
WHERE src.family LIKE 'synthprod%'
ON CONFLICT DO NOTHING;

INSERT INTO occurrence_category_tag (occurrence_id, category_id, tag_type)
SELECT o.id, o.primary_category_id, 'category'::tag_type
FROM activity_occurrence o
JOIN activity_series s ON s.id = o.series_id
JOIN source src ON src.id = s.source_id
WHERE src.family LIKE 'synthprod%' AND o.primary_category_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Provenance, including a URL with credentials embedded — the redact_contact specimen.
INSERT INTO provenance (occurrence_id, field, source_url, source_family, fetched_at, fact_origin)
SELECT o.id, 'start_datetime_utc',
       CASE WHEN o.id = 'eeee0000-0000-4000-8000-000000000002'
            THEN 'https://synthprod-scraper:s3cr3t@example.org/rec/feed.json'
            ELSE coalesce(o.source_url, 'https://example.org/synthprod') END,
       src.family, o.last_checked_at, 'source'
FROM activity_occurrence o
JOIN activity_series s ON s.id = o.series_id
JOIN source src ON src.id = s.source_id
WHERE src.family LIKE 'synthprod%' AND o.last_checked_at IS NOT NULL;

-- A user-submitted correction report, so the excluded-table canary covers that path too.
INSERT INTO correction_report (occurrence_id, reporter, issue_type, note)
VALUES ('eeee0000-0000-4000-8000-000000000001', 'CANARY-anon-session-7c1', 'CANARY_wrong_time',
        'CANARY: this is actually at 10am — my daughter Rosa (age 4) missed it. Reach me at 604-555-0188.');

COMMIT;
