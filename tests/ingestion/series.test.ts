import { describe, it, expect, afterAll } from 'vitest';
import { NoopAdapter } from '../../worker/core/adapter';
import { resolveSeries } from '../../worker/core/series';
import { upsertOccurrence } from '../../worker/core/upsert';
import { getPool, query, closePool } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);

// G-T5-4 — series resolution: activity_occurrence.series_id is NOT NULL, so
// upsertOccurrence needs a series. resolveSeries provides it (resolve-or-insert),
// closing the gap where the framework test previously hand-rolled the INSERT.
describe.skipIf(!hasDb)('Series resolution (G-T5-4)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('resolve-or-inserts a series idempotently on (source_id, canonical_title)', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('noop', $1) RETURNING id`,
      [`Series Test Source ${crypto.randomUUID()}`]
    );

    const first = await resolveSeries(pool, { sourceId: source.id, canonicalTitle: 'Open Gym' });
    expect(first.created).toBe(true);

    const second = await resolveSeries(pool, { sourceId: source.id, canonicalTitle: 'Open Gym' });
    expect(second.created).toBe(false);
    expect(second.seriesId).toBe(first.seriesId); // reused, not duplicated

    const rows = await query<{ n: string }>(
      `SELECT count(*) AS n FROM activity_series WHERE source_id = $1 AND canonical_title = 'Open Gym'`,
      [source.id]
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it('feeds upsertOccurrence so a NoopAdapter record upserts under the resolved series', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('noop', $1) RETURNING id`,
      [`Series Ingest Source ${crypto.randomUUID()}`]
    );
    const adapter = new NoopAdapter();
    const record = (await adapter.extract(await adapter.fetch()))[0];

    const { seriesId } = await resolveSeries(pool, {
      sourceId: source.id,
      canonicalTitle: record.title,
    });
    const { occurrenceId, created } = await upsertOccurrence(pool, seriesId, record);
    expect(created).toBe(true);

    // The occurrence is attached to the resolved (NOT NULL) series.
    const [occ] = await query<{ series_id: string }>(
      `SELECT series_id FROM activity_occurrence WHERE id = $1`,
      [occurrenceId]
    );
    expect(occ.series_id).toBe(seriesId);
  });
});
