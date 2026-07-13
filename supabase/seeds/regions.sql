-- regions.sql — G-T3-2: Metro Vancouver -> municipality -> sub-area hierarchy
-- + centroids (TSD §5B BR-07/08). Requires migrations through 0009_geo_columns.sql
-- (G-T4-2, region.centroid) to already be applied. Fixed UUIDs so this seed is
-- idempotent (ON CONFLICT (id) DO UPDATE) and children can reference parents
-- without a lookup — `region` has no natural-key uniqueness in the schema.

INSERT INTO region (id, name, level, parent_id, centroid) VALUES
  ('10000000-0000-0000-0000-000000000001', 'Metro Vancouver', 'metro', NULL,
    ST_SetSRID(ST_MakePoint(-123.0946, 49.2610), 4326)::geography)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, level = EXCLUDED.level,
  parent_id = EXCLUDED.parent_id, centroid = EXCLUDED.centroid;

INSERT INTO region (id, name, level, parent_id, centroid) VALUES
  ('10000000-0000-0000-0000-000000000010', 'Vancouver', 'municipality', '10000000-0000-0000-0000-000000000001',
    ST_SetSRID(ST_MakePoint(-123.1207, 49.2827), 4326)::geography),
  ('10000000-0000-0000-0000-000000000011', 'North Vancouver', 'municipality', '10000000-0000-0000-0000-000000000001',
    ST_SetSRID(ST_MakePoint(-123.0693, 49.3163), 4326)::geography),
  ('10000000-0000-0000-0000-000000000012', 'West Vancouver', 'municipality', '10000000-0000-0000-0000-000000000001',
    ST_SetSRID(ST_MakePoint(-123.1591, 49.3286), 4326)::geography),
  ('10000000-0000-0000-0000-000000000013', 'Burnaby', 'municipality', '10000000-0000-0000-0000-000000000001',
    ST_SetSRID(ST_MakePoint(-122.9805, 49.2488), 4326)::geography),
  ('10000000-0000-0000-0000-000000000014', 'Richmond', 'municipality', '10000000-0000-0000-0000-000000000001',
    ST_SetSRID(ST_MakePoint(-123.1336, 49.1666), 4326)::geography)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, level = EXCLUDED.level,
  parent_id = EXCLUDED.parent_id, centroid = EXCLUDED.centroid;

INSERT INTO region (id, name, level, parent_id, centroid) VALUES
  ('10000000-0000-0000-0000-000000000020', 'East Van', 'sub_area', '10000000-0000-0000-0000-000000000010',
    ST_SetSRID(ST_MakePoint(-123.0710, 49.2620), 4326)::geography),
  ('10000000-0000-0000-0000-000000000021', 'West Side', 'sub_area', '10000000-0000-0000-0000-000000000010',
    ST_SetSRID(ST_MakePoint(-123.1650, 49.2530), 4326)::geography)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, level = EXCLUDED.level,
  parent_id = EXCLUDED.parent_id, centroid = EXCLUDED.centroid;
