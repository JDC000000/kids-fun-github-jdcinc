// tests/saved_search_ui_roundtrip.test.ts — proves the /search "Save this search"
// button → DB → re-run loop end-to-end against a real Postgres with RLS (Round 10
// / Task B). Task 38's CRUD ownership is proven separately in
// tests/saved_search_crud.test.ts; this asserts the NEW piece: a filter state
// serialized by the search page persists through the production createSavedSearch /
// listSavedSearches helpers and re-parses into the identical SearchState, and that
// raw near-me coordinates never reach the database.
//
// Runs only when USER_DATABASE_URL is configured (the RLS `authenticated` role);
// otherwise it skips, exactly like the other RLS suites.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSavedSearch, listSavedSearches } from '../lib/db/saved-search';
import { closeUserPool } from '../lib/db/user-scoped-client';
import { query, closePool } from '../lib/db/client';
import {
  DEFAULT_STATE,
  parseSearchState,
  serializeStateToParams,
  savedSearchKey,
  type SearchState,
} from '@/app/search/_lib/params';

const hasUserDb = Boolean(process.env.DATABASE_URL) && Boolean(process.env.USER_DATABASE_URL);

const RICH_STATE: SearchState = {
  q: 'family swim',
  sort: 'soonest',
  includeUnknownCost: false,
  regions: ['van', 'bby'],
  when: 'weekend',
  timeOfDay: 'morning',
  bookableNow: true,
  rainyDay: false,
  dropIn: true,
  free: true,
  costMaxCad: 20,
  ages: ['2-4', '5-9'],
  lat: null,
  lng: null,
  useSavedLocation: true,
  radiusKm: 20,
};

describe.skipIf(!hasUserDb)('saved-search /search round-trip through real Postgres (Task B)', () => {
  let userId: string;

  beforeAll(async () => {
    const [u] = await query<{ id: string }>(
      `INSERT INTO user_profile (id) VALUES (gen_random_uuid()) RETURNING id`
    );
    userId = u.id;
  });

  afterAll(async () => {
    await closeUserPool();
    await closePool();
  });

  it('a serialized /search state survives create→list and re-parses identically', async () => {
    const params = serializeStateToParams(RICH_STATE);
    const created = await createSavedSearch(userId, { name: 'Weekend swim', params });
    expect(created.params).toEqual(params);

    const list = await listSavedSearches(userId);
    const row = list.find((s) => s.id === created.id);
    expect(row).toBeDefined();
    expect(row!.params).toEqual(params);

    // The button → DB → re-run loop: the stored params re-parse into the same state.
    const reparsed = parseSearchState(row!.params as unknown as Record<string, string>);
    expect(reparsed).toEqual(RICH_STATE);

    // The dedupe key is stable across the DB round-trip (drives "already saved").
    expect(savedSearchKey(row!.params)).toBe(savedSearchKey(params));
  });

  it('never writes raw near-me coordinates to the database (privacy)', async () => {
    const nearMe: SearchState = { ...DEFAULT_STATE, q: 'swim', lat: 49.2827, lng: -123.1207, radiusKm: 20 };
    const params = serializeStateToParams(nearMe);
    expect('lat' in params).toBe(false);
    expect('lng' in params).toBe(false);

    const created = await createSavedSearch(userId, { name: null, params });
    const list = await listSavedSearches(userId);
    const row = list.find((s) => s.id === created.id);
    expect(row).toBeDefined();
    expect('lat' in row!.params).toBe(false);
    expect('lng' in row!.params).toBe(false);
    expect(row!.params).toEqual({ q: 'swim' });
  });
});
