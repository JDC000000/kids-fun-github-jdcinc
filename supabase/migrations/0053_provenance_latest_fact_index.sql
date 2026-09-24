-- 0053_provenance_latest_fact_index.sql — keep recordProvenance()'s "latest fact" lookup O(1).
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- Since 2026-09-23, worker/core/provenance.ts inserts a fact only when it differs from the LATEST
-- row for that (occurrence_id, field):
--     SELECT … FROM provenance WHERE occurrence_id = $1 AND field = $2
--      ORDER BY fetched_at DESC, id DESC LIMIT 1
-- The only index was (occurrence_id), so each lookup read EVERY row of the occurrence (all fields)
-- and top-N sorted them. Before the 2026-09-24 cleanup that was ~700 rows per occurrence and
-- measured 331 ms / 716 cold page reads per fact. After it, it is ~5 rows, which is fine today, but
-- the cost would grow again with the table. This index serves the lookup as a single index probe
-- in exactly the order the predicate asks for, independent of table size.
--
-- ── COST ────────────────────────────────────────────────────────────────────
-- Built on 2026-09-24 against the post-cleanup table (~153K rows, 40 MB). Plain CREATE INDEX,
-- matching every other index in this repo (scripts/migrate.sh runs each file in one transaction,
-- which rules out CONCURRENTLY). It takes a SHARE lock on provenance for the build: reads continue,
-- crawl INSERTs wait for it (sub-second at this size — measured locally on 160K rows, see the PR).
-- Building this BEFORE the cleanup would have meant a ~23M-row sort on a near-full disk.
--
-- idx_provenance_occurrence (occurrence_id) is now a prefix of this index and therefore redundant
-- for reads. It is deliberately KEPT here — dropping it is a separate, reviewable decision.
CREATE INDEX IF NOT EXISTS idx_provenance_occurrence_field_latest
  ON provenance (occurrence_id, field, fetched_at DESC, id DESC);

-- ── rollback ────────────────────────────────────────────────────────────────
--   DROP INDEX IF EXISTS idx_provenance_occurrence_field_latest;
