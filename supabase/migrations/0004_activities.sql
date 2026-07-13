-- 0004_activities.sql — G-T2-3: activity_series / activity_occurrence (TSD §6.1, §6.2).
-- Series vs occurrence: recurring/drop-in programs are a series; each date is an
-- occurrence. Open-hours attractions are a series with open_hours_state and no
-- fixed occurrence times; special events at the same venue are their own occurrences.
-- primary_category_id / default_primary_category / default_tags[] reference the
-- taxonomy tables created in 0005_taxonomy.sql — FK constraints for the category
-- reference are attached there once `category` exists; tag arrays are unenforced
-- (standard Postgres limitation on array FKs), joined properly via
-- occurrence_category_tag for anything that needs referential integrity.

-- ── forward ──────────────────────────────────────────────────────────────────
CREATE TABLE activity_series (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_title          text NOT NULL,
  recurrence_rule          text, -- RRULE-style string; null for one-off/open-hours series
  source_id                uuid NOT NULL REFERENCES source(id),
  venue_id                 uuid REFERENCES venue(id),
  season_state             season_state NOT NULL DEFAULT 'active',
  default_primary_category uuid, -- FK to category(id) attached in 0005_taxonomy.sql
  default_tags             uuid[] NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER activity_series_set_updated_at
  BEFORE UPDATE ON activity_series
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_activity_series_source ON activity_series(source_id);
CREATE INDEX idx_activity_series_venue ON activity_series(venue_id);

CREATE TABLE activity_occurrence (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id             uuid NOT NULL REFERENCES activity_series(id),
  activity_name         text NOT NULL,
  description_snippet   text,
  primary_category_id   uuid, -- FK to category(id) attached in 0005_taxonomy.sql
  start_datetime_utc    timestamptz, -- null for open-hours series (see open_hours_state)
  end_datetime_utc      timestamptz,
  open_hours_state      text, -- e.g. "Daily 9am-5pm"; populated instead of fixed times
  cost_min_cad          numeric(10,2),
  cost_max_cad          numeric(10,2),
  cost_status           cost_status NOT NULL DEFAULT 'unknown',
  source_url            text,
  booking_url           text,
  location_url          text,
  status_state          status_state NOT NULL DEFAULT 'needs_review',
  confidence_label      text NOT NULL DEFAULT 'unscored'
                          CHECK (confidence_label IN ('unscored','low','medium','high')),
  last_checked_at       timestamptz,
  next_check_at         timestamptz,
  archived_at           timestamptz, -- soft-delete (TSD §6.2 cross-cutting canon)
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT occurrence_has_time_or_open_hours
    CHECK (start_datetime_utc IS NOT NULL OR open_hours_state IS NOT NULL)
);

CREATE TRIGGER activity_occurrence_set_updated_at
  BEFORE UPDATE ON activity_occurrence
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_activity_occurrence_series ON activity_occurrence(series_id);
CREATE INDEX idx_activity_occurrence_start ON activity_occurrence(start_datetime_utc);
CREATE INDEX idx_activity_occurrence_status ON activity_occurrence(status_state);
CREATE INDEX idx_activity_occurrence_not_archived ON activity_occurrence(id) WHERE archived_at IS NULL;

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS activity_occurrence;
--   DROP TABLE IF EXISTS activity_series;
