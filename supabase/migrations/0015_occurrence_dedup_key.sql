-- 0014_occurrence_dedup_key.sql — Schema enabler for T14 dedup / Track C ingestion.
-- Adds activity_occurrence.dedup_key + a UNIQUE index so the ingestion sink's
-- idempotent upsert `ON CONFLICT (dedup_key)` (worker/core/upsert.ts PgOccurrenceSink,
-- G-T5-4) runs against Postgres instead of the in-memory reference sink.
--
-- SCOPE: this is the schema HOOK only. The deterministic dedup ENGINE
-- (keys / adjudicate / merge, T14 / TSD §5.2) remains out of scope here.
-- NULL dedup_key is allowed (NULLs are distinct in a unique index) so manual /
-- non-deduplicable rows never collide; the sink routes empty-key records to review
-- rather than inserting a NULL key. A full (non-partial) unique index is used so it
-- matches the sink's bare `ON CONFLICT (dedup_key)` inference.
--
-- Src: TSD v1.2 §5.2/§6.2, scope-to-task v1.1 §C (T14). Deps: 0004_activities.
-- Forward-only; reversible steps recorded below.

-- ── forward ──────────────────────────────────────────────────────────────────
ALTER TABLE activity_occurrence ADD COLUMN IF NOT EXISTS dedup_key text;
CREATE UNIQUE INDEX IF NOT EXISTS occurrence_dedup_key ON activity_occurrence (dedup_key);

-- ── rollback (reversible) ────────────────────────────────────────────────────
--   DROP INDEX IF EXISTS occurrence_dedup_key;
--   ALTER TABLE activity_occurrence DROP COLUMN IF EXISTS dedup_key;
