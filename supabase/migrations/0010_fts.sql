-- 0010_fts.sql — G-T4-3: weighted tsvector + GIN/trigram indexes + populate
-- trigger (TSD §5A.1). Weighted A=activity_name, B=primary_category+tags,
-- C=venue+source (see note below), D=description_snippet. Synonym text is
-- deliberately NOT baked into the vector — alias expansion happens query-time
-- only (0010 is storage/index only; lib/search/expand.ts does the expansion).
--
-- Note on weight C: TSD §5A.1 specifies "venue_name + organisation", but the
-- §6.1 column list gives activity_series only source_id + venue_id (no
-- organisation_id on series/occurrence). We use venue.name + source.name for
-- weight C, which covers the same "where/who" relevance signal with the FKs
-- that actually exist; wiring a direct organisation_id is a candidate
-- follow-up if/when that gap is resolved upstream (flagged, not fabricated).

-- ── forward ──────────────────────────────────────────────────────────────────
ALTER TABLE activity_occurrence ADD COLUMN search_tsv tsvector;

CREATE OR REPLACE FUNCTION compute_occurrence_search_tsv(
  p_occurrence_id uuid,       -- pass NULL on first INSERT (tag join table is empty until AFTER insert)
  p_activity_name text,
  p_description_snippet text,
  p_primary_category_id uuid,
  p_series_id uuid
) RETURNS tsvector AS $$
  SELECT
    setweight(to_tsvector('english', coalesce(p_activity_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(c.label, '') || ' ' || coalesce(tag_labels.labels, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(v.name, '') || ' ' || coalesce(s.name, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(p_description_snippet, '')), 'D')
  FROM (SELECT 1) AS dummy
  LEFT JOIN category c ON c.id = p_primary_category_id
  LEFT JOIN activity_series ser ON ser.id = p_series_id
  LEFT JOIN venue v ON v.id = ser.venue_id
  LEFT JOIN source s ON s.id = ser.source_id
  LEFT JOIN LATERAL (
    SELECT string_agg(t.label, ' ') AS labels
    FROM occurrence_category_tag oct
    JOIN tag t ON t.id = oct.tag_id
    WHERE p_occurrence_id IS NOT NULL AND oct.occurrence_id = p_occurrence_id
  ) tag_labels ON true;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION trg_set_occurrence_search_tsv() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv := compute_occurrence_search_tsv(
    NEW.id, NEW.activity_name, NEW.description_snippet, NEW.primary_category_id, NEW.series_id
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_occurrence_set_search_tsv
  BEFORE INSERT OR UPDATE ON activity_occurrence
  FOR EACH ROW EXECUTE FUNCTION trg_set_occurrence_search_tsv();

-- Re-index when secondary categories/suitability tags change after insert.
CREATE OR REPLACE FUNCTION trg_reindex_occurrence_from_tag() RETURNS trigger AS $$
DECLARE
  occ_id uuid := COALESCE(NEW.occurrence_id, OLD.occurrence_id);
BEGIN
  UPDATE activity_occurrence o
  SET search_tsv = compute_occurrence_search_tsv(
    o.id, o.activity_name, o.description_snippet, o.primary_category_id, o.series_id
  )
  WHERE o.id = occ_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER occurrence_category_tag_reindex
  AFTER INSERT OR DELETE ON occurrence_category_tag
  FOR EACH ROW EXECUTE FUNCTION trg_reindex_occurrence_from_tag();

CREATE INDEX idx_activity_occurrence_search_tsv ON activity_occurrence USING GIN (search_tsv);
CREATE INDEX idx_activity_occurrence_name_trgm ON activity_occurrence USING GIN (activity_name gin_trgm_ops);
CREATE INDEX idx_venue_name_trgm ON venue USING GIN (name gin_trgm_ops);

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP INDEX IF EXISTS idx_venue_name_trgm;
--   DROP INDEX IF EXISTS idx_activity_occurrence_name_trgm;
--   DROP INDEX IF EXISTS idx_activity_occurrence_search_tsv;
--   DROP TRIGGER IF EXISTS occurrence_category_tag_reindex ON occurrence_category_tag;
--   DROP FUNCTION IF EXISTS trg_reindex_occurrence_from_tag();
--   DROP TRIGGER IF EXISTS activity_occurrence_set_search_tsv ON activity_occurrence;
--   DROP FUNCTION IF EXISTS trg_set_occurrence_search_tsv();
--   DROP FUNCTION IF EXISTS compute_occurrence_search_tsv(uuid, text, text, uuid, uuid);
--   ALTER TABLE activity_occurrence DROP COLUMN IF EXISTS search_tsv;
