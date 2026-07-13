import { describe, it, expect, afterAll } from 'vitest';
import { NoopAdapter, type Adapter, type StructuredRecord } from '../../worker/core/adapter';
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

  it('attaches geocoded venue metadata to the resolved series', async () => {
    const pool = getPool();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name) VALUES ('library_bibliocommons', $1) RETURNING id`,
      [`Venue Ingest Source ${crypto.randomUUID()}`]
    );
    const record: StructuredRecord = {
      sourceRecordId: `venue-record-${crypto.randomUUID()}`,
      title: 'Family Storytime',
      venueName: 'Steveston Library (Easthope Hub)',
      venueAddress: '4320 Moncton St, Richmond, BC V7E 6T4',
      venueLat: 49.12546,
      venueLng: -123.1783832,
      venueMunicipalityName: 'Richmond',
      venueDisplayArea: 'Steveston',
      startDatetimeUtc: '2026-09-24T18:00:00.000Z',
      endDatetimeUtc: '2026-09-24T18:30:00.000Z',
      costStatus: 'free',
      categoryHint: 'storytime',
      sourceUrl: 'https://yourlibrary.bibliocommons.com/v2/events/venue-test',
      locationUrl: 'https://www.google.com/maps/search/?api=1&query=4320%20Moncton%20St%20Richmond%20BC%20V7E%206T4',
    };
    const adapter: Adapter = {
      family: 'library',
      fetch: async () => [record],
      extract: (raw) => raw as StructuredRecord[],
      dedupKeys: () => ({ key: 'venue-record' }),
    };

    const summary = await ingestSource(pool, adapter, source.id);
    expect(summary.errors).toEqual([]);

    const [row] = await query<{ venue_name: string; display_area: string; lat: string; lng: string; location_url: string }>(
      `SELECT v.name AS venue_name, v.display_area,
              ST_Y(v.geo::geometry)::text AS lat,
              ST_X(v.geo::geometry)::text AS lng,
              o.location_url
       FROM activity_occurrence o
       JOIN activity_series s ON s.id = o.series_id
       JOIN venue v ON v.id = s.venue_id
       WHERE s.source_id = $1`,
      [source.id]
    );

    expect(row.venue_name).toBe('Steveston Library (Easthope Hub)');
    expect(row.display_area).toBe('Steveston');
    expect(Number(row.lat)).toBeCloseTo(49.12546, 5);
    expect(Number(row.lng)).toBeCloseTo(-123.1783832, 5);
    expect(row.location_url).toContain('4320%20Moncton');
  });
});
