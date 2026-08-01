// tests/search/facets.perf.test.ts — Facet counting has to be cheap enough to run on EVERY
// filter interaction, because that is what a live count-driven rail does. This pins the two
// properties that make that true and would be silently lost in a refactor:
//
//   1. Facets add no I/O and no second text match — they are a handful of in-memory filter
//      passes over the candidate set the search already built. So the marginal cost of
//      `facets: true` stays a fraction of the search it rides along with.
//   2. That cost is linear in the candidate count, not quadratic in candidates × values.
//
// Budgets are deliberately loose (this runs on shared CI hardware); they are there to catch
// an order-of-magnitude regression — a per-value repository call, a re-run matcher, an
// accidental O(n²) — not to police a few milliseconds.

import { describe, it, expect } from 'vitest';
import { SearchEngine } from '../../lib/search/engine';
import { InMemoryListingRepository } from '../../lib/search/repository';
import { FixtureAliasResolver } from '../../lib/search/expand';
import { RegionHierarchy } from '../../lib/geo/region';
import { REGIONS, REGION_IDS } from '../../lib/search/__fixtures__/regions';
import { makeListing, resetSeq } from '../../lib/search/__fixtures__/factory';
import { FIXTURE_NOW } from '../../lib/search/__fixtures__/engine';
import type { AgeBandKey, ListingRecord, StatusState } from '../../lib/search/types';

const MUNICIPALITIES = [REGION_IDS.vancouver, REGION_IDS.northVan, REGION_IDS.westVan, REGION_IDS.burnaby, REGION_IDS.richmond];
const STATUSES: StatusState[] = ['confirmed', 'bookable_open', 'stale', 'seasonal_active', 'full'];
const AGE_BANDS: AgeBandKey[] = ['under2', '2-4', '5-9', '10-14', '15+'];
const CATEGORIES = ['open_gym', 'public_swim', 'skate', 'storytime', 'indoor_play', 'nature'];

/** A deterministic, evenly-spread catalogue — every facet value has real work to count. */
function buildCatalogue(size: number): ListingRecord[] {
  resetSeq();
  // 2026-07-13 16:00Z = 09:00 local. Spread over 4 days (today → this weekend) and 10 hours
  // (09:00–18:00 local) so morning / afternoon / evening all carry results.
  const epoch = Date.UTC(2026, 6, 13, 16, 0, 0);
  const HOUR = 3_600_000;
  return Array.from({ length: size }, (_, i) => {
    const start = new Date(epoch + ((i % 4) * 24 + (i % 10)) * HOUR);
    return makeListing({
      id: `perf-${i}`,
      activityName: `${CATEGORIES[i % CATEGORIES.length]} session ${i}`,
      primaryCategoryKey: CATEGORIES[i % CATEGORIES.length],
      venueName: `Centre ${i % 40}`,
      suitabilityTags: i % 3 === 0 ? ['indoor', 'drop_in'] : ['outdoor'],
      startDatetimeUtc: start.toISOString(),
      endDatetimeUtc: new Date(start.getTime() + HOUR).toISOString(),
      costStatus: i % 5 === 0 ? 'free' : 'known',
      costMinCad: i % 5 === 0 ? null : (i % 12) * 5,
      costMaxCad: i % 5 === 0 ? null : (i % 12) * 5,
      statusState: STATUSES[i % STATUSES.length],
      ageBandMatches: [AGE_BANDS[i % AGE_BANDS.length], AGE_BANDS[(i + 1) % AGE_BANDS.length]],
      geo: { lat: 49.2 + (i % 20) * 0.01, lng: -123.2 + (i % 25) * 0.01 },
      municipalityId: MUNICIPALITIES[i % MUNICIPALITIES.length],
    });
  });
}

function makeEngine(listings: ListingRecord[]): SearchEngine {
  return new SearchEngine({
    repository: new InMemoryListingRepository(listings),
    aliasResolver: new FixtureAliasResolver(),
    regionHierarchy: new RegionHierarchy(REGIONS),
    fixtureBacked: false,
  });
}

/** Median wall-clock of `runs` timed calls, after a warm-up (JIT + first-call noise). */
function medianMs(runs: number, fn: () => void): number {
  for (let i = 0; i < 3; i += 1) fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return samples.sort((a, b) => a - b)[Math.floor(runs / 2)];
}

describe('facet counting cost', () => {
  it('adds only a fraction of the search it rides along with (500 listings ≈ today\'s page size)', () => {
    const engine = makeEngine(buildCatalogue(500));
    const req = { q: 'swim', now: FIXTURE_NOW, minResults: 0, includeUnknownCost: true, limit: 60 };

    const withoutFacets = medianMs(15, () => engine.search(req));
    const withFacets = medianMs(15, () => engine.search({ ...req, facets: true }));
    const marginal = withFacets - withoutFacets;

    // Absolute ceiling: comfortably inside a single interaction's budget.
    expect(marginal).toBeLessThan(25);
    // Relative ceiling: facets must stay cheaper than the search itself. If this ever fails,
    // something started doing real work per facet value (a query, or a second match pass).
    expect(marginal).toBeLessThan(withoutFacets * 2);
  });

  it('scales linearly with the candidate count, not with candidates × facet values', () => {
    const small = makeEngine(buildCatalogue(500));
    const large = makeEngine(buildCatalogue(5000));
    const req = { q: '', now: FIXTURE_NOW, minResults: 0, includeUnknownCost: true, limit: 60 };

    const facetCost = (engine: SearchEngine) =>
      medianMs(9, () => engine.search({ ...req, facets: true })) - medianMs(9, () => engine.search(req));

    const at500 = Math.max(facetCost(small), 0.05); // floor: avoid dividing by timer noise
    const at5000 = facetCost(large);

    // 10x the data should cost ~10x, not ~100x. Generous headroom for a noisy shared runner:
    // measured ~9x and ~55ms on a 4-core box (~5ms at the 500-listing page the loader caps at).
    expect(at5000 / at500).toBeLessThan(30);
    expect(at5000).toBeLessThan(200);
  });
});
