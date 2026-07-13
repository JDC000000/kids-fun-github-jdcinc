import { afterAll, describe, expect, it } from 'vitest';
import { getPool, query, closePool } from '../../lib/db/client';
import { loadPostgresListings } from '../../lib/search/postgres-repository';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('Postgres search repository', () => {
  afterAll(async () => {
    await closePool();
  });

  it('maps occurrence + series + source rows into the search read model', async () => {
    const pool = getPool();
    const suffix = crypto.randomUUID();
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name, authority_tier) VALUES ('library_bibliocommons', $1, 'official') RETURNING id`,
      [`Repository Test Source ${suffix}`]
    );
    const [category] = await query<{ id: string }>(`SELECT id FROM category WHERE key = 'storytime' LIMIT 1`);
    const [series] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`,
      [`Family Storytime — Test Branch ${suffix}`, source.id]
    );
    const [occurrence] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (
         series_id, source_record_id, activity_name, primary_category_id,
         start_datetime_utc, end_datetime_utc, cost_status, source_url,
         status_state, confidence_label, last_checked_at
       ) VALUES ($1,$2,$3,$4,'2026-09-17T17:30:00Z','2026-09-17T18:00:00Z','free',$5,'confirmed','high',now())
       RETURNING id`,
      [series.id, `repo-test-${suffix}`, `Family Storytime ${suffix}`, category.id, 'https://example.org/events/repo-test']
    );

    const listings = await loadPostgresListings(pool);
    const listing = listings.find((l) => l.id === occurrence.id);

    expect(listing).toBeTruthy();
    expect(listing?.activityName).toBe(`Family Storytime ${suffix}`);
    expect(listing?.primaryCategoryKey).toBe('storytime');
    expect(listing?.categoryTags).toContain('storytime');
    expect(listing?.venueName).toContain('Test Branch');
    expect(listing?.organisation).toBe(`Repository Test Source ${suffix}`);
    expect(listing?.statusState).toBe('confirmed');
    expect(listing?.confidenceLabel).toBe('official_recent');
    expect(listing?.costStatus).toBe('free');
    expect(listing?.sourceUrl).toBe('https://example.org/events/repo-test');
  });

  it('does not return expired fixed-time occurrences from the live read model', async () => {
    const [source] = await query<{ id: string }>(
      `INSERT INTO source (family, name, authority_tier) VALUES ('library_bibliocommons', $1, 'official') RETURNING id`,
      [`Expired Repository Source ${crypto.randomUUID()}`]
    );
    const [category] = await query<{ id: string }>(`SELECT id FROM category WHERE key = 'storytime' LIMIT 1`);
    const [series] = await query<{ id: string }>(
      `INSERT INTO activity_series (canonical_title, source_id) VALUES ($1, $2) RETURNING id`,
      [`Past Family Storytime ${crypto.randomUUID()}`, source.id]
    );
    const [occurrence] = await query<{ id: string }>(
      `INSERT INTO activity_occurrence (
         series_id, source_record_id, activity_name, primary_category_id,
         start_datetime_utc, end_datetime_utc, cost_status, source_url,
         status_state, confidence_label, last_checked_at
       ) VALUES ($1,$2,'Past Family Storytime',$3, now() - interval '2 days', now() - interval '2 days' + interval '30 minutes', 'free', 'https://example.org/past', 'confirmed', 'high', now())
       RETURNING id`,
      [series.id, `past-${crypto.randomUUID()}`, category.id]
    );

    const listings = await loadPostgresListings(getPool());
    expect(listings.some((l) => l.id === occurrence.id)).toBe(false);
  });

});
