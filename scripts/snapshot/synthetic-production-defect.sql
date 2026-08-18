-- scripts/snapshot/synthetic-production-defect.sql — LOCAL / TEST ONLY.
--
-- Plants ONE real data-shape defect into the synthetic production database, of exactly the
-- class this whole snapshot pipeline exists to catch: a `municipality` region with a NULL
-- centroid. Distance and radius search join through region.centroid, and tests/regions.test.ts
-- asserts `count(*) FROM region WHERE centroid IS NULL = 0` — but only ever against seeded
-- reference data, which by construction always has one.
--
-- A fixture cannot find this bug. Only real rows can. Apply this file, re-export, re-load, and
-- run `npm run test:snapshot`: the shape suite goes red and names the row. That demonstration
-- is the argument for the whole pipeline, in one command.
--
-- It is deliberately NOT part of synthetic-production.sql, so the default dataset is clean and
-- the snapshot lane is green out of the box.
--
--   psql "$KF_SNAPSHOT_SOURCE_URL" -v ON_ERROR_STOP=1 -f scripts/snapshot/synthetic-production-defect.sql
BEGIN;

-- Parented to the SEEDED metro region (supabase/seeds/regions.sql), since synthetic-
-- production.sql deliberately no longer invents one of its own.
--
-- Level is 'sub_area', not 'municipality': tests/admin/data-health-db.test.ts asserts the
-- municipality set equals the LAUNCH_REGIONS constant, and adding a municipality here would
-- fail that suite too — muddying a demonstration that is supposed to isolate ONE finding.
INSERT INTO region (id, name, level, parent_id, centroid) VALUES
  ('aaaa0000-0000-4000-8000-0000000000ff', 'Synthprod Anmore (defect specimen)', 'sub_area',
   (SELECT id FROM region WHERE level = 'metro' LIMIT 1), NULL)
ON CONFLICT (id) DO UPDATE SET centroid = NULL;

COMMIT;

-- ── DEFECT 2: REFERENCE-DATA DRIFT ───────────────────────────────────────────────────
--
-- This one is the sharpest argument for the whole pipeline, so read it before deleting it.
--
-- A municipality in the LIVE database has been renamed since supabase/seeds/regions.sql was
-- written — the "region-name drift" failure mode. tests/admin/data-health-db.test.ts asserts
-- that the set of municipality names equals the LAUNCH_REGIONS constant in the app.
--
-- In FIXTURE MODE that assertion can never fail, and not because the code is correct: the test
-- reads a region table that was populated from the seed file, and the seed file and the
-- constant were written together. The fixture IS the expectation. It is a tautology wearing a
-- test's clothes.
--
-- In SNAPSHOT MODE the same assertion compares the app's constant against what PRODUCTION
-- actually holds — so a rename that happened in the live database, months after the seed file
-- was last touched, finally has something that can see it.
--
-- Apply, re-export, re-load, run `npm run test:snapshot`, and watch data-health-db go red.
UPDATE region
   SET name = 'North Vancouver (District)'
 WHERE name = 'North Vancouver' AND level = 'municipality';
