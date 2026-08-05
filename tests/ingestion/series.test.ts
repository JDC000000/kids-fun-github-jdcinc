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

  it('uses the database uniqueness guard under concurrent series resolution', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('noop', $1) RETURNING id`,
      [`Concurrent Series Source ${crypto.randomUUID()}`]
    );
    const title = `Concurrent Open Gym ${crypto.randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 8 }, () => resolveSeries(pool, { sourceId: source.id, canonicalTitle: title }))
    );

    expect(new Set(results.map((r) => r.seriesId)).size).toBe(1);
    expect(results.filter((r) => r.created).length).toBe(1);

    const rows = await query<{ n: string }>(
      `SELECT count(*) AS n FROM activity_series WHERE source_id = $1 AND canonical_title = $2`,
      [source.id, title]
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

  // Option A (supabase/migrations/0027). The column is TRI-STATE and the write path is the
  // only place the third state can be destroyed: `?? false` instead of `?? null` in
  // upsertOccurrence would turn every silent source into a drop-in claim, and nothing else
  // in the suite would notice. Asserted against real SQL, including the round trip on
  // re-ingest, because that is where the coercion would happen.
  it('persists registrationRequired as a tri-state, and re-ingest corrects it', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('noop', $1) RETURNING id`,
      [`Registration Tri-State Source ${crypto.randomUUID()}`]
    );
    const { seriesId } = await resolveSeries(pool, { sourceId: source.id, canonicalTitle: 'Tri-State Gym' });

    const base = {
      title: 'Tri-State Gym',
      startDatetimeUtc: '2026-08-14T18:00:00.000Z',
      costStatus: 'unknown' as const,
      sourceUrl: 'https://example.org/tri-state',
    };

    const read = async (id: string) => {
      const [row] = await query<{ registration_required: boolean | null }>(
        `SELECT registration_required FROM activity_occurrence WHERE id = $1`,
        [id]
      );
      return row.registration_required;
    };

    try {
    const required = await upsertOccurrence(pool, seriesId, { ...base, sourceRecordId: 'tri-true', registrationRequired: true });
    const dropIn = await upsertOccurrence(pool, seriesId, { ...base, sourceRecordId: 'tri-false', registrationRequired: false });
    const silent = await upsertOccurrence(pool, seriesId, { ...base, sourceRecordId: 'tri-null' });

    expect(await read(required.occurrenceId)).toBe(true);
    // FALSE, not null: the source positively said no booking is needed.
    expect(await read(dropIn.occurrenceId)).toBe(false);
    // NULL, not false: an adapter that emits nothing must not assert drop-in.
    expect(await read(silent.occurrenceId)).toBeNull();

    // Plain overwrite on conflict, NOT COALESCE — a vendor moving an item out of its drop-in
    // calendar has to be able to correct the row. A COALESCE write path would pin the false.
    const reIngest = await upsertOccurrence(pool, seriesId, { ...base, sourceRecordId: 'tri-false', registrationRequired: true });
    expect(reIngest.created).toBe(false);
    expect(reIngest.occurrenceId).toBe(dropIn.occurrenceId);
    expect(await read(dropIn.occurrenceId)).toBe(true);
    } finally {
      // Same reason as the roundtrip test in tests/search/postgres-repository.test.ts: these
      // rows are visible to every DB-lane suite that reads a global aggregate, and left
      // behind they accumulate across runs until they displace other suites' fixtures.
      // Scoped to this test's own source, never a blanket DELETE.
      await query(
        `DELETE FROM activity_occurrence WHERE series_id IN (SELECT id FROM activity_series WHERE source_id = $1)`,
        [source.id]
      );
      await query(`DELETE FROM activity_series WHERE source_id = $1`, [source.id]);
      await query(`DELETE FROM source WHERE id = $1`, [source.id]);
    }
  });
});
