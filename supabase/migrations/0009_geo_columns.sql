-- 0009_geo_columns.sql — G-T4-2: venue geography + GIST index + region centroids
-- (TSD §5B BR-06). Also adds user_profile.home_geo, deferred from 0007 for the
-- same reason (PostGIS not enabled until 0008_extensions.sql / G-T4-1).

-- ── forward ──────────────────────────────────────────────────────────────────
ALTER TABLE venue ADD COLUMN geo geography(Point, 4326);
CREATE INDEX idx_venue_geo ON venue USING GIST (geo);

ALTER TABLE region ADD COLUMN centroid geography(Point, 4326);
CREATE INDEX idx_region_centroid ON region USING GIST (centroid);

ALTER TABLE user_profile ADD COLUMN home_geo geography(Point, 4326);

-- ── rollback ────────────────────────────────────────────────────────────────
--   ALTER TABLE user_profile DROP COLUMN IF EXISTS home_geo;
--   DROP INDEX IF EXISTS idx_region_centroid;
--   ALTER TABLE region DROP COLUMN IF EXISTS centroid;
--   DROP INDEX IF EXISTS idx_venue_geo;
--   ALTER TABLE venue DROP COLUMN IF EXISTS geo;
