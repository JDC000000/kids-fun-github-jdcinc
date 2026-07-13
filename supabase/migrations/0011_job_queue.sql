-- 0011_job_queue.sql — G-T5-2: Postgres job-queue table (TSD §3A.1, §5).
-- Also adds activity_occurrence.source_record_id — a pragmatic scaffold column
-- beyond the literal §6.1 list, needed for G-T5-4's idempotent same-source
-- upsert (worker/core/upsert.ts). This is distinct from T14's Deduplication
-- engine, which merges duplicates *across* sources by fuzzy title/venue/time
-- similarity; this column only makes re-ingesting the *same* source record
-- idempotent (upsert-in-place instead of duplicating on every check).

-- ── forward ──────────────────────────────────────────────────────────────────
CREATE TABLE job_queue (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id    uuid REFERENCES source(id),
  job_type     text NOT NULL DEFAULT 'ingest',
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','done','failed','dead_letter')),
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER job_queue_set_updated_at
  BEFORE UPDATE ON job_queue
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_job_queue_dequeue ON job_queue (scheduled_for) WHERE status = 'pending';
CREATE INDEX idx_job_queue_source ON job_queue(source_id);
CREATE INDEX idx_job_queue_source_active ON job_queue(source_id) WHERE status IN ('pending','running');

ALTER TABLE activity_occurrence ADD COLUMN source_record_id text;

CREATE UNIQUE INDEX idx_activity_occurrence_series_source_record
  ON activity_occurrence(series_id, source_record_id)
  WHERE source_record_id IS NOT NULL;

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP INDEX IF EXISTS idx_activity_occurrence_series_source_record;
--   ALTER TABLE activity_occurrence DROP COLUMN IF EXISTS source_record_id;
--   DROP TABLE IF EXISTS job_queue;
