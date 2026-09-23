// worker/core/provenance.ts — G-T5-4: fact-level provenance logging (TSD §6.1 IR-04).
// Every displayed fact traces to a provenance row (source URL, family, fetch time, origin) — this
// is what powers the source-transparency UX (NR-02).
//
// ═══ RECORD CHANGES, NOT RE-CONFIRMATIONS (2026-09-23) ═══
// This used to INSERT unconditionally, once per fact per record per crawl. With the 7 sources
// crawled ~64×/day that re-recorded every fact ~9×/day: by 2026-09-22 provenance held 22.8M rows /
// 5.77 GB for ~32K occurrences (~700 rows each, growing ~630K rows/day), and every one of its 77,210
// (occurrence, field) timelines held exactly ONE distinct content — i.e. 99.3% of the table was
// byte-identical re-confirmations differing only in id and fetched_at.
// (Re-measured 2026-09-23 by QA: 23.35M rows / 6.19 GB, 78,493 timelines, still all single-content;
// growth observed that evening ≈870 rows/min, i.e. faster than the ~630K/day above.)
//
// A fact is now inserted only when it differs from the LATEST row for that (occurrence, field) in
// source_url / source_family / fact_origin. The table stays append-only (TSD §6.1), every change
// point is still recorded with the time it was first observed, and "is this still current?" remains
// answered by activity_occurrence.last_checked_at, which the upsert refreshes on every crawl.
// No production code reads provenance.fetched_at as a last-seen time (checked 2026-09-23).
//
// CONCURRENCY — what this does and does not guarantee (QA 2026-09-23, measured on Postgres 17): the
// check and the insert are one statement, but under READ COMMITTED the NOT EXISTS cannot see another
// writer's uncommitted row, so N concurrent writers of the SAME new fact can each insert it (16
// writers wrote 1–16 rows). A change point is never lost (B racing A was recorded 40/40 times), and
// a duplicate is exactly the pure re-confirmation that scripts/incident/provenance-bloat removes, so
// this is left unlocked on purpose: the scheduler already runs at most one job per source
// (worker/scheduler/tiered.ts skips a source with a pending/running job). "Latest" is
// max(fetched_at, id) — the same order that tool's rule uses — so a row stamped in the future would
// stay "latest" until the clock passes it (production code only ever writes fetched_at as DEFAULT now()).
import type { Pool } from 'pg';

export interface ProvenanceFact {
  occurrenceId: string;
  field: string;
  sourceUrl: string;
  sourceFamily?: string;
  factOrigin?: 'source' | 'llm_normalised' | 'manual_override';
}

/** Returns how many rows were actually inserted (facts identical to the latest row are skipped). */
export async function recordProvenance(pool: Pool, facts: ProvenanceFact[]): Promise<number> {
  let inserted = 0;
  for (const fact of facts) {
    const r = await pool.query(
      `INSERT INTO provenance (occurrence_id, field, source_url, source_family, fact_origin)
       SELECT $1, $2, $3, $4, $5
        WHERE NOT EXISTS (
          SELECT 1
            FROM (SELECT source_url, source_family, fact_origin
                    FROM provenance
                   WHERE occurrence_id = $1 AND field = $2
                   ORDER BY fetched_at DESC, id DESC
                   LIMIT 1) latest
           WHERE latest.source_url = $3
             AND latest.source_family IS NOT DISTINCT FROM $4
             AND latest.fact_origin = $5)`,
      [fact.occurrenceId, fact.field, fact.sourceUrl, fact.sourceFamily ?? null, fact.factOrigin ?? 'source']
    );
    inserted += r.rowCount ?? 0;
  }
  return inserted;
}
