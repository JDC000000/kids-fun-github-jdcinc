-- 0016_activity_series_identity.sql — harden series identity for concurrent ingest.
--
-- worker/core/series.ts resolves activity_series rows by (source_id, canonical_title).
-- The job queue normally prevents two active jobs for one source, but a database
-- constraint is the durable guardrail: concurrent one-off/manual runs must not be
-- able to create duplicate series and split occurrences across them.

-- ── forward ──────────────────────────────────────────────────────────────────
-- If a pre-index staging run ever created duplicates, keep the oldest row and move
-- occurrences to it before adding the uniqueness invariant.
WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY source_id, canonical_title
      ORDER BY created_at ASC, id ASC
    ) AS keeper_id,
    row_number() OVER (
      PARTITION BY source_id, canonical_title
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM activity_series
)
UPDATE activity_occurrence o
SET series_id = ranked.keeper_id
FROM ranked
WHERE ranked.rn > 1
  AND o.series_id = ranked.id;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY source_id, canonical_title
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM activity_series
)
DELETE FROM activity_series s
USING ranked
WHERE ranked.rn > 1
  AND s.id = ranked.id;

CREATE UNIQUE INDEX idx_activity_series_source_title_unique
  ON activity_series(source_id, canonical_title);

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP INDEX IF EXISTS idx_activity_series_source_title_unique;
