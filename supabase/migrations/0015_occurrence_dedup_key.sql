-- 0015_occurrence_dedup_key.sql — Schema hook for future T14 cross-source dedup.
-- Adds activity_occurrence.dedup_key + a UNIQUE index reserved for the deterministic
-- dedup engine (keys / adjudicate / merge, T14 / TSD §5.2).
--
-- NOTE: current ingestion idempotency does NOT use this column. worker/core/upsert.ts
-- currently upserts same-source records with (series_id, source_record_id), matching
-- 0011_job_queue.sql's partial unique index. dedup_key is intentionally unused until
-- the T14 cross-source dedup workflow is implemented.
--
-- SCOPE: this is the schema HOOK only. The deterministic dedup ENGINE remains out
-- of scope here. NULL dedup_key is allowed (NULLs are distinct in a unique index)
-- so manual / non-deduplicable rows never collide.
--
-- Src: TSD v1.2 §5.2/§6.2, scope-to-task v1.1 §C (T14). Deps: 0004_activities.
-- Forward-only; reversible steps recorded below.

-- ── forward ──────────────────────────────────────────────────────────────────
ALTER TABLE activity_occurrence ADD COLUMN IF NOT EXISTS dedup_key text;
CREATE UNIQUE INDEX IF NOT EXISTS occurrence_dedup_key ON activity_occurrence (dedup_key);

-- ── rollback (reversible) ────────────────────────────────────────────────────
--   DROP INDEX IF EXISTS occurrence_dedup_key;
--   ALTER TABLE activity_occurrence DROP COLUMN IF EXISTS dedup_key;
