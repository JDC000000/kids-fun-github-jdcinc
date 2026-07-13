// tests/search/sort.test.ts — Deterministic alternate sorts over one filtered set (G-T19-3).

import { describe, it, expect } from 'vitest';
import { applySort } from '../../lib/search/sort';
import type { ScoredListing } from '../../lib/search/rank';
import { makeListing } from '../../lib/search/__fixtures__/factory';

function scored(over: Partial<Parameters<typeof makeListing>[0]>, score: number, distanceKm: number | null): ScoredListing {
  return {
    candidate: { listing: makeListing(over), relevance: 1, matchedTerms: [], categoryHit: false },
    score,
    distanceKm,
    components: {
      tsRank: 0, ageMatch: 0, dateProximity: 0, distanceDecay: 0,
      statusConfidenceBoost: 0, suitabilityMatch: 0, recency: 0,
    },
  };
}

const set: ScoredListing[] = [
  scored({ id: 'a', costStatus: 'known', costMinCad: 10, startDatetimeUtc: '2026-07-15T00:00:00Z', lastCheckedAtUtc: '2026-07-10T00:00:00Z' }, 0.9, 8),
  scored({ id: 'b', costStatus: 'free', startDatetimeUtc: '2026-07-13T00:00:00Z', lastCheckedAtUtc: '2026-07-12T00:00:00Z' }, 0.5, 2),
  scored({ id: 'c', costStatus: 'known', costMinCad: 5, startDatetimeUtc: '2026-07-14T00:00:00Z', lastCheckedAtUtc: '2026-07-11T00:00:00Z' }, 0.7, 5),
];

const ids = (r: ScoredListing[]) => r.map((x) => x.candidate.listing.id);

describe('applySort — deterministic orderings over the SAME set', () => {
  it('best_match sorts by descending score', () => {
    expect(ids(applySort(set, 'best_match'))).toEqual(['a', 'c', 'b']);
  });
  it('distance sorts nearest first', () => {
    expect(ids(applySort(set, 'distance'))).toEqual(['b', 'c', 'a']);
  });
  it('soonest sorts by earliest start', () => {
    expect(ids(applySort(set, 'soonest'))).toEqual(['b', 'c', 'a']);
  });
  it('lowest_cost sorts free/cheapest first', () => {
    expect(ids(applySort(set, 'lowest_cost'))).toEqual(['b', 'c', 'a']);
  });
  it('newest sorts most-recently-checked first', () => {
    expect(ids(applySort(set, 'newest'))).toEqual(['b', 'c', 'a']);
  });
  it('does not mutate the input array', () => {
    const before = ids(set);
    applySort(set, 'distance');
    expect(ids(set)).toEqual(before);
  });
});
