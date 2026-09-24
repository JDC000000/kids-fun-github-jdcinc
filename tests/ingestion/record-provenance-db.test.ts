// tests/ingestion/record-provenance-db.test.ts — recordProvenance() records CHANGES, not re-confirmations.
//
// Pins the 2026-09-23 fix (worker/core/provenance.ts). Before it, every crawl inserted a provenance
// row per fact unconditionally: by 2026-09-22 the table held 22.8M rows for ~32K occurrences, 99.3%
// of them byte-identical re-confirmations. The fix inserts a fact only when it differs from the
// LATEST row for that (occurrence, field) in source_url / source_family / fact_origin. Verified live
// on 2026-09-24 (10,585 write calls → 110 inserts, all first observations); this suite is the
// repo-resident version of the checks that proved it, so a regression fails the build.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NoopAdapter } from '../../worker/core/adapter';
import { recordProvenance, type ProvenanceFact } from '../../worker/core/provenance';
import { upsertOccurrence } from '../../worker/core/upsert';
import { getPool, query, closePool } from '../../lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('recordProvenance — record changes, not re-confirmations (2026-09-23)', () => {
  let seriesId: string;
  let n = 0;
  const run = crypto.randomUUID();

  beforeAll(async () => {
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('noop', $1) RETURNING id`, [`Provenance Dedup Test ${run}`]);
    const [venue] = await query<{ id: string }>(`INSERT INTO venue (name) VALUES ('Provenance Dedup Venue') RETURNING id`);
    const [series] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id, venue_id) VALUES ('Provenance Dedup Series', $1, $2) RETURNING id`,
      [source.id, venue.id]);
    seriesId = series.id;
  });

  afterAll(async () => {
    await closePool();
  });

  /** A fresh occurrence with no provenance yet. */
  async function newOccurrence(): Promise<string> {
    const [record] = await new NoopAdapter().extract([{ id: 'x' }]);
    const { occurrenceId } = await upsertOccurrence(getPool(), seriesId, { ...record, sourceRecordId: `prov-${run}-${n++}` });
    return occurrenceId;
  }
  const fact = (occurrenceId: string, o: Partial<ProvenanceFact> = {}): ProvenanceFact =>
    ({ occurrenceId, field: 'activity_name', sourceUrl: 'https://example.org/a', sourceFamily: 'library', factOrigin: 'source', ...o });
  const timeline = async (occurrenceId: string, field = 'activity_name') =>
    (await query<{ source_url: string; source_family: string | null; fact_origin: string }>(
      `SELECT source_url, source_family, fact_origin FROM provenance WHERE occurrence_id = $1 AND field = $2 ORDER BY fetched_at, id`,
      [occurrenceId, field]));
  const count = async (occurrenceId: string) =>
    Number((await query<{ n: string }>(`SELECT count(*)::text AS n FROM provenance WHERE occurrence_id = $1`, [occurrenceId]))[0].n);

  it('records a first observation and returns the number of rows written', async () => {
    const o = await newOccurrence();
    expect(await recordProvenance(getPool(), [fact(o)])).toBe(1);
    expect(await count(o)).toBe(1);
  });

  it('skips an identical re-confirmation, crawl after crawl', async () => {
    const o = await newOccurrence();
    await recordProvenance(getPool(), [fact(o)]);
    let written = 0;
    for (let crawl = 0; crawl < 10; crawl++) written += await recordProvenance(getPool(), [fact(o)]);
    expect(written).toBe(0);
    expect(await count(o)).toBe(1);
  });

  it('records every change point: URL A → B → A is three rows, in order', async () => {
    const o = await newOccurrence();
    await recordProvenance(getPool(), [fact(o, { sourceUrl: 'https://example.org/A' })]);
    await recordProvenance(getPool(), [fact(o, { sourceUrl: 'https://example.org/A' })]);
    await recordProvenance(getPool(), [fact(o, { sourceUrl: 'https://example.org/B' })]);
    await recordProvenance(getPool(), [fact(o, { sourceUrl: 'https://example.org/A' })]);
    expect((await timeline(o)).map((r) => r.source_url)).toEqual(['https://example.org/A', 'https://example.org/B', 'https://example.org/A']);
  });

  it('a change of fact_origin or source_family is a change', async () => {
    const o = await newOccurrence();
    await recordProvenance(getPool(), [fact(o)]);
    expect(await recordProvenance(getPool(), [fact(o, { factOrigin: 'manual_override' })])).toBe(1);
    expect(await recordProvenance(getPool(), [fact(o, { factOrigin: 'manual_override', sourceFamily: 'activenet' })])).toBe(1);
    expect(await recordProvenance(getPool(), [fact(o, { factOrigin: 'manual_override', sourceFamily: 'activenet' })])).toBe(0);
  });

  it('treats NULL source_family NULL-safely: NULL re-confirmation skipped, NULL → value recorded', async () => {
    const o = await newOccurrence();
    expect(await recordProvenance(getPool(), [fact(o, { sourceFamily: undefined })])).toBe(1);
    expect(await recordProvenance(getPool(), [fact(o, { sourceFamily: undefined })])).toBe(0);
    expect(await recordProvenance(getPool(), [fact(o, { sourceFamily: 'library' })])).toBe(1);
    expect((await timeline(o)).map((r) => r.source_family)).toEqual([null, 'library']);
  });

  it('fields are independent: a change in one field writes only that field', async () => {
    const o = await newOccurrence();
    const facts = (url2: string) => [
      fact(o, { field: 'activity_name' }), fact(o, { field: 'start_datetime_utc', sourceUrl: url2 }), fact(o, { field: 'age_min_months' }),
    ];
    expect(await recordProvenance(getPool(), facts('https://example.org/a'))).toBe(3);
    expect(await recordProvenance(getPool(), facts('https://example.org/a'))).toBe(0);
    expect(await recordProvenance(getPool(), facts('https://example.org/moved'))).toBe(1);
    expect(await timeline(o, 'start_datetime_utc')).toHaveLength(2);
    expect(await timeline(o, 'activity_name')).toHaveLength(1);
  });

  it('empty input writes nothing', async () => {
    expect(await recordProvenance(getPool(), [])).toBe(0);
  });
});
