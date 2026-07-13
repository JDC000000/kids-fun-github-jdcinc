-- 0005_taxonomy.sql — G-T2-4: taxonomy tables (TSD §6.1, §6.2 BR-01/09/10).
-- category / tag / occurrence_category_tag / synonym_alias / age_band /
-- occurrence_age / region. Also attaches the FK constraints deferred from
-- 0003/0004 now that category and region exist:
--   venue.municipality_id -> region(id)
--   activity_series.default_primary_category -> category(id)
--   activity_occurrence.primary_category_id -> category(id)
-- region.centroid (geography) is added later in 0009_geo_columns.sql (G-T4-2),
-- once PostGIS is enabled in 0008_extensions.sql (G-T4-1).

-- ── forward ──────────────────────────────────────────────────────────────────
CREATE TABLE category (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                text NOT NULL UNIQUE,
  label              text NOT NULL,
  is_primary_eligible boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tag (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text NOT NULL UNIQUE,
  label      text NOT NULL,
  tag_type   tag_type NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE occurrence_category_tag (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id uuid NOT NULL REFERENCES activity_occurrence(id),
  category_id   uuid REFERENCES category(id),
  tag_id        uuid REFERENCES tag(id),
  tag_type      tag_type NOT NULL,
  CONSTRAINT occurrence_category_tag_one_target CHECK (
    (category_id IS NOT NULL AND tag_id IS NULL AND tag_type = 'category')
    OR
    (tag_id IS NOT NULL AND category_id IS NULL AND tag_type <> 'category')
  )
);

CREATE UNIQUE INDEX idx_occurrence_category_tag_cat_unique
  ON occurrence_category_tag(occurrence_id, category_id) WHERE category_id IS NOT NULL;
CREATE UNIQUE INDEX idx_occurrence_category_tag_tag_unique
  ON occurrence_category_tag(occurrence_id, tag_id) WHERE tag_id IS NOT NULL;
CREATE INDEX idx_occurrence_category_tag_occurrence ON occurrence_category_tag(occurrence_id);

CREATE TABLE synonym_alias (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alias_text           text NOT NULL,
  canonical_category_id uuid REFERENCES category(id),
  canonical_tag_id     uuid REFERENCES tag(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT synonym_alias_one_target CHECK (
    (canonical_category_id IS NOT NULL) <> (canonical_tag_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_synonym_alias_text_unique ON synonym_alias (lower(alias_text));

CREATE TABLE age_band (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                    text NOT NULL UNIQUE, -- under2 / 2-4 / 5-9 / 10-14 / 15+
  lower_months_inclusive integer NOT NULL,
  upper_months_exclusive integer, -- null = open-ended (Teens 15+)
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT age_band_bounds_valid CHECK (
    upper_months_exclusive IS NULL OR upper_months_exclusive > lower_months_inclusive
  )
);

CREATE TABLE occurrence_age (
  occurrence_id     uuid PRIMARY KEY REFERENCES activity_occurrence(id),
  age_min_months    integer,
  age_max_months    integer,
  age_band_matches  uuid[] NOT NULL DEFAULT '{}', -- age_band ids (array FK unenforced, standard PG limitation)
  age_notes         text
);

CREATE TABLE region (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  level      text NOT NULL CHECK (level IN ('metro','municipality','sub_area')),
  parent_id  uuid REFERENCES region(id),
  created_at timestamptz NOT NULL DEFAULT now()
  -- centroid geography(Point,4326) added in 0009_geo_columns.sql (G-T4-2)
);

CREATE INDEX idx_region_parent ON region(parent_id);

-- Deferred FKs now that category/region exist.
ALTER TABLE venue
  ADD CONSTRAINT venue_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES region(id);

ALTER TABLE activity_series
  ADD CONSTRAINT activity_series_default_primary_category_fkey
    FOREIGN KEY (default_primary_category) REFERENCES category(id);

ALTER TABLE activity_occurrence
  ADD CONSTRAINT activity_occurrence_primary_category_id_fkey
    FOREIGN KEY (primary_category_id) REFERENCES category(id);

-- ── rollback ────────────────────────────────────────────────────────────────
--   ALTER TABLE activity_occurrence DROP CONSTRAINT IF EXISTS activity_occurrence_primary_category_id_fkey;
--   ALTER TABLE activity_series DROP CONSTRAINT IF EXISTS activity_series_default_primary_category_fkey;
--   ALTER TABLE venue DROP CONSTRAINT IF EXISTS venue_municipality_id_fkey;
--   DROP TABLE IF EXISTS region;
--   DROP TABLE IF EXISTS occurrence_age;
--   DROP TABLE IF EXISTS age_band;
--   DROP TABLE IF EXISTS synonym_alias;
--   DROP TABLE IF EXISTS occurrence_category_tag;
--   DROP TABLE IF EXISTS tag;
--   DROP TABLE IF EXISTS category;
