-- 0003_core_places.sql — G-T2-2: core place tables (TSD §6.1).
-- source / organisation / venue. venue.municipality_id references region(id),
-- but the FK constraint is added in 0005_taxonomy.sql once region exists
-- (region is created in G-T2-4, ahead of venue's FK attachment).
-- venue.geo (PostGIS geography) is added in 0009_geo_columns.sql (G-T4-2).

-- ── forward ──────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE source (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family             text NOT NULL,
  name               text NOT NULL,
  authority_tier     text NOT NULL DEFAULT 'official'
                       CHECK (authority_tier IN ('official','editorial','partner','manual')),
  terms_status       text NOT NULL DEFAULT 'pending'
                       CHECK (terms_status IN ('pending','allowed','summarise_only','disallowed','blocked')),
  robots_status      text NOT NULL DEFAULT 'pending'
                       CHECK (robots_status IN ('pending','allowed','disallowed','unknown')),
  platform           text,
  publication_horizon interval,
  baseline_cadence   interval NOT NULL DEFAULT '1 day',
  near_date_cadence  interval,
  season_state       season_state NOT NULL DEFAULT 'unknown',
  health_state       text NOT NULL DEFAULT 'unknown'
                       CHECK (health_state IN ('healthy','degraded','stale','failing','unknown')),
  ingestion_method   ingestion_method NOT NULL DEFAULT 'manual',
  last_check_at      timestamptz,
  next_check_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER source_set_updated_at
  BEFORE UPDATE ON source
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per source/tenant (e.g. one ActiveNet row per municipality); backs
-- the idempotent registry seed (G-T3-4, supabase/seeds/sources.sql).
CREATE UNIQUE INDEX idx_source_family_name_unique ON source (family, name);

CREATE TABLE organisation (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  type           text,
  website        text,
  contact        text,
  source_family  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER organisation_set_updated_at
  BEFORE UPDATE ON organisation
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE venue (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  address              text,
  municipality_id      uuid, -- FK to region(id) attached in 0005_taxonomy.sql
  neighbourhood        text,
  display_area         text,
  accessibility_notes  text,
  official_url         text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER venue_set_updated_at
  BEFORE UPDATE ON venue
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS venue;
--   DROP TABLE IF EXISTS organisation;
--   DROP TABLE IF EXISTS source;
--   DROP FUNCTION IF EXISTS set_updated_at();
