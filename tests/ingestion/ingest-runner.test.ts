import { describe, it, expect, afterAll } from 'vitest';
import { NoopAdapter } from '../../worker/core/adapter';
import { ingestSource } from '../../worker/core/ingest';
import { getPool, query, closePool } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);

// G-T5-4 — ingest runner wires series resolution into the DB-backed upsert:
// resolveSeries (create/reuse activity_series) → upsertOccurrence(series_id, …) →
// provenance → check-run. This is the "series_id wiring before any DB-backed
// occurrence upsert" the review flagged as the remaining blocker.
describe.skipIf(!hasDb)('Ingest runner series_id wiring (G-T5-4)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('resolves a series and writes check-run + occurrence + provenance for a source', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('noop', $1) RETURNING id`,
      [`Ingest Runner Source ${crypto.randomUUID()}`]
    );

    const summary = await ingestSource(pool, new NoopAdapter(), source.id);

    expect(summary.errors).toEqual([]);
    expect(summary.recordsFound).toBeGreaterThan(0);
    expect(summary.seriesCreated).toBe(1);
    expect(summary.occurrencesCreated).toBe(1);
    expect(summary.provenanceRows).toBeGreaterThanOrEqual(1);

    // check-run recorded as success.
    const [run] = await query<{ status: string; records_found: number }>(
      `SELECT status, records_found FROM source_check_run WHERE id = $1`,
      [summary.checkRunId]
    );
    expect(run.status).toBe('success');

    // occurrence exists and is attached to a (NOT NULL) series for this source.
    const occ = await query<{ series_id: string; status_state: string; confidence_label: string; category_key: string }>(
      `SELECT o.series_id, o.status_state, o.confidence_label, c.key AS category_key
       FROM activity_occurrence o
       JOIN activity_series s ON s.id = o.series_id
       LEFT JOIN category c ON c.id = o.primary_category_id
       WHERE s.source_id = $1`,
      [source.id]
    );
    expect(occ.length).toBe(1);
    expect(occ[0].series_id).not.toBeNull();
    expect(occ[0].status_state).toBe('confirmed');
    expect(occ[0].confidence_label).toBe('medium');
    expect(occ[0].category_key).toBe('class_program');
  });

  it('is idempotent: a second run reuses the series and updates the occurrence in place', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('noop', $1) RETURNING id`,
      [`Ingest Idempotent Source ${crypto.randomUUID()}`]
    );
    const adapter = new NoopAdapter();

    const first = await ingestSource(pool, adapter, source.id);
    const second = await ingestSource(pool, adapter, source.id);

    expect(first.occurrencesCreated).toBe(1);
    expect(second.occurrencesCreated).toBe(0); // updated in place, not duplicated
    expect(second.seriesCreated).toBe(0); // series reused

    const [seriesCount] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM activity_series WHERE source_id = $1`,
      [source.id]
    );
    expect(Number(seriesCount.n)).toBe(1);
    const [occCount] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM activity_occurrence o
       JOIN activity_series s ON s.id = o.series_id WHERE s.source_id = $1`,
      [source.id]
    );
    expect(Number(occCount.n)).toBe(1);
  });
});
