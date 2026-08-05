import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { RegionHierarchy } from '../../lib/geo/region';
import { FixtureAliasResolver } from '../../lib/search/expand';
import { ALIAS_SEED } from '../../lib/search/__fixtures__/aliases';
import { REGIONS } from '../../lib/search/__fixtures__/regions';
import { SearchEngine } from '../../lib/search/engine';
import { loadPostgresListings } from '../../lib/search/postgres-repository';
import { InMemoryListingRepository } from '../../lib/search/repository';
import { HIDDEN_STATUSES } from '../../lib/search/filters/status';

type CapturedQuery = {
  text: string;
  values: unknown[];
};

function row(i: number, activityName = `Filler Activity ${i}`) {
  return {
    id: `cap-row-${i}`,
    series_id: `cap-series-${i}`,
    activity_name: activityName,
    primary_category_key: 'class_program',
    tag_keys: [],
    venue_name: 'Cap Test Centre',
    source_name: 'Cap Test Source',
    series_title: activityName,
    source_authority_tier: 'official',
    description_snippet: '',
    start_datetime_utc: '2026-09-01T17:00:00Z',
    end_datetime_utc: '2026-09-01T18:00:00Z',
    open_hours_state: null,
    cost_status: 'free',
    cost_min_cad: null,
    cost_max_cad: null,
    source_url: 'https://example.org/cap-test',
    booking_url: null,
    location_url: null,
    status_state: 'confirmed',
    confidence_label: 'high',
    last_checked_at: '2026-08-05T00:00:00Z',
    age_min_months: null,
    age_max_months: null,
    age_notes: null,
    age_band_keys: [],
    lat: null,
    lng: null,
    municipality_id: null,
    neighbourhood: null,
    display_area: null,
    phone: null,
  };
}

function fakePool(rows: ReturnType<typeof row>[]) {
  const calls: CapturedQuery[] = [];
  const pool = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      const limitParam = /\bLIMIT\s+\$(\d+)\b/i.exec(text);
      const limit = limitParam ? Number(values[Number(limitParam[1]) - 1]) : null;
      return { rows: limit == null ? rows : rows.slice(0, limit) };
    },
  } as unknown as Pool;

  return { pool, calls };
}

function searchResultIds(listings: Awaited<ReturnType<typeof loadPostgresListings>>, q: string): string[] {
  const engine = new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver: new FixtureAliasResolver(ALIAS_SEED),
    regionHierarchy: new RegionHierarchy(REGIONS),
    fixtureBacked: false,
  });
  return engine.search({ q, minResults: 0, limit: 10 }).results.map((item) => item.listing.id);
}

describe('Postgres search repository catalogue cap', () => {
  it('loads the full visible catalogue by default, so search can match rows beyond position 500', async () => {
    const sentinel = row(501, 'Neon Panther Gymnastics');
    const { pool, calls } = fakePool([...Array.from({ length: 500 }, (_, i) => row(i)), sentinel]);

    const listings = await loadPostgresListings(pool);

    expect(calls[0].text).not.toMatch(/\bLIMIT\s+\$/i);
    expect(calls[0].values).toEqual([HIDDEN_STATUSES]);
    expect(listings).toHaveLength(501);
    expect(searchResultIds(listings, 'neon panther')).toEqual(['cap-row-501']);
  });

  it('keeps an explicit diagnostic limit available without making it the production default', async () => {
    const { pool, calls } = fakePool(Array.from({ length: 25 }, (_, i) => row(i)));

    const listings = await loadPostgresListings(pool, { limit: 7 });

    expect(calls[0].text).toMatch(/\bLIMIT\s+\$2\b/i);
    expect(calls[0].values).toEqual([HIDDEN_STATUSES, 7]);
    expect(listings.map((listing) => listing.id)).toEqual([
      'cap-row-0',
      'cap-row-1',
      'cap-row-2',
      'cap-row-3',
      'cap-row-4',
      'cap-row-5',
      'cap-row-6',
    ]);
  });
});
