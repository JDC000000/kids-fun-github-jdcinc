// worker/core/provenance.ts — G-T5-4: fact-level provenance logging (TSD §6.1 IR-04).
// Every displayed fact traces to a provenance row (source URL, family, fetch
// time, origin) — this is what powers the source-transparency UX (NR-02).
import type { Pool } from 'pg';

export interface ProvenanceFact {
  occurrenceId: string;
  field: string;
  sourceUrl: string;
  sourceFamily?: string;
  factOrigin?: 'source' | 'llm_normalised' | 'manual_override';
}

export async function recordProvenance(pool: Pool, facts: ProvenanceFact[]): Promise<void> {
  for (const fact of facts) {
    await pool.query(
      `INSERT INTO provenance (occurrence_id, field, source_url, source_family, fact_origin)
       VALUES ($1, $2, $3, $4, $5)`,
      [fact.occurrenceId, fact.field, fact.sourceUrl, fact.sourceFamily ?? null, fact.factOrigin ?? 'source']
    );
  }
}
