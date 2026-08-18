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
