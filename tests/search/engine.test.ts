// tests/search/engine.test.ts — End-to-end search assembly (G-T16-7, FR-02/09/10).

import { describe, it, expect } from 'vitest';
import { makeFixtureEngine, FIXTURE_NOW } from '../../lib/search/__fixtures__/engine';

const eastVan = { lat: 49.26, lng: -123.07 };

describe('SearchEngine.search (FR-02)', () => {
  const { engine } = makeFixtureEngine();

  it('"open gym near me" returns open-gym listings ranked before unrelated ones', () => {
    const res = engine.search({ q: 'open gym near me', now: FIXTURE_NOW, origin: { mode: 'near_me', coords: eastVan }, minResults: 1 });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].listing.primaryCategoryKey).toBe('open_gym');
    // no unrelated categories, and cancelled/hidden never surfaced
    expect(res.results.every((r) => r.listing.primaryCategoryKey === 'open_gym')).toBe(true);
    expect(res.results.some((r) => r.listing.id === 'l-cancelled-gym')).toBe(false);
    expect(res.meta.fixtureBacked).toBe(true);
  });

  it('confirmed/bookable outranks an otherwise-equal stale listing end-to-end (FR-02 + §5A.3)', () => {
    const res = engine.search({ q: 'open gym', now: FIXTURE_NOW, origin: { mode: 'near_me', coords: eastVan }, minResults: 1 });
    const ids = res.results.map((r) => r.listing.id);
    expect(ids.indexOf('l-rank-confirmed')).toBeLessThan(ids.indexOf('l-rank-stale'));
  });

  it('honours the time-of-day filter at the API layer, not just chips (FR-09)', () => {
    const res = engine.search({ q: 'open gym morning', now: FIXTURE_NOW, origin: { mode: 'near_me', coords: eastVan }, minResults: 1 });
    const ids = res.results.map((r) => r.listing.id);
    expect(ids).toContain('l-opengym-van'); // 10:00 local
    expect(ids).not.toContain('l-gymplay-nvan'); // 14:00 local (afternoon)
  });

  it('honours the cost filter — free excludes unknown unless include-unknown is set (FR-10)', () => {
    const free = engine.search({ q: 'storytime free', now: FIXTURE_NOW, minResults: 1 });
    const freeIds = free.results.map((r) => r.listing.id);
    expect(freeIds).toContain('l-storytime-van'); // genuinely free
    // An unknown-cost listing is still not CLASSIFIED as free, but it is no longer HIDDEN:
    // there is no include-unknown flag to set any more (lib/search/filters/cost.ts).
    expect(freeIds).toContain('l-storytime-unknown');
  });

  it('honours the max-price ceiling end-to-end — "under $N" drops pricier listings (G-T21-4)', () => {
    // minResults:0 disables the broadening ladder so we observe the raw filtered set
    // (otherwise "drop the most restrictive chip" would re-add the excluded listing).
    const base = engine.search({ q: 'aquarium', now: FIXTURE_NOW, minResults: 0 });
    expect(base.results.map((r) => r.listing.id)).toContain('l-aquarium-van'); // $40, shown with no ceiling
    const capped = engine.search({ q: 'aquarium under $20', now: FIXTURE_NOW, minResults: 0 });
    expect(capped.results.map((r) => r.listing.id)).not.toContain('l-aquarium-van'); // $40 > $20 → excluded
  });

  it('honours a custom date range end-to-end — only in-range days survive, open-hours always (T26/FR-04)', () => {
    const res = engine.search({
      q: '',
      now: FIXTURE_NOW,
      dateRange: { from: '2026-07-13', to: '2026-07-14' },
      minResults: 0,
      limit: 100,
    });
    expect(res.context.date).toMatchObject({ kind: 'range', isoDate: '2026-07-13', endIsoDate: '2026-07-14' });
    const ids = res.results.map((r) => r.listing.id);
    expect(ids).toContain('l-opengym-van'); // 2026-07-13 local → inside range
    expect(ids).toContain('l-familydropin-bby'); // 2026-07-14 local → inside range
    expect(ids).not.toContain('l-skate-rmd'); // 2026-07-15 local → outside range
    expect(ids).toContain('l-aquarium-van'); // open-hours → available every day, always in range
  });

  it('canonicalises a reversed date range (from>to) before filtering (T26)', () => {
    const res = engine.search({
      q: '',
      now: FIXTURE_NOW,
      dateRange: { from: '2026-07-14', to: '2026-07-13' },
      minResults: 0,
      limit: 100,
    });
    expect(res.context.date).toMatchObject({ kind: 'range', isoDate: '2026-07-13', endIsoDate: '2026-07-14' });
  });

  it('ignores a malformed date range (no date constraint applied) (T26)', () => {
    const res = engine.search({ q: '', now: FIXTURE_NOW, dateRange: { from: 'not-a-date', to: '2026-07-14' }, minResults: 0, limit: 100 });
    expect(res.context.date).toBeNull();
  });

  it('honours the drop-in chip end-to-end — only drop_in-tagged listings survive (G-T21-3)', () => {
    const res = engine.search({ q: 'open gym drop-in', now: FIXTURE_NOW, minResults: 0 });
    expect(res.results.length).toBeGreaterThan(0);
    expect(
      res.results.every((r) => [...r.listing.suitabilityTags, ...r.listing.categoryTags].includes('drop_in')),
    ).toBe(true);
    expect(res.results.map((r) => r.listing.id)).not.toContain('l-rank-confirmed'); // open_gym but not drop_in
  });

  it('applies the distance sort control over the same filtered set', () => {
    const res = engine.search({
      q: 'open gym', now: FIXTURE_NOW, origin: { mode: 'near_me', coords: eastVan }, sort: 'distance', minResults: 1,
    });
    const distances = res.results.map((r) => r.distanceKm ?? Infinity);
    const sorted = [...distances].sort((a, b) => a - b);
    expect(distances).toEqual(sorted);
  });
});
