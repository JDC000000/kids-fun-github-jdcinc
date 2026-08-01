// Same-series-same-day collapsing (lib/search/collapse.ts).
//
// The rule the rest of the pipeline depends on: collapsing REMOVES REPEATS AND NOTHING ELSE.
// It must not reorder results (ranking and sort own position), must not merge across days or
// across series, and must not touch listings that have no day to belong to.

import { describe, expect, it } from 'vitest';
import { collapseSameDaySeries, slotSpanEnd } from '../../lib/search/collapse';
import type { ScoredListing } from '../../lib/search/rank';
import { makeListing } from '../../lib/search/__fixtures__/factory';
import type { ListingRecord } from '../../lib/search/types';

/** A minimal scored entry — collapsing reads only the listing and preserves the rest verbatim. */
function scored(overrides: Partial<ListingRecord> & { id: string }, score = 1): ScoredListing {
  return {
    candidate: { listing: makeListing(overrides), relevance: 1, matchedTerms: [], categoryHit: true },
    score,
    distanceKm: null,
    components: {} as ScoredListing['components'],
  };
}

// Three slots of one piano series on the same Vancouver day, plus a fourth the next day.
const PIANO = 'series-piano';
const slot1 = scored({ id: 'a', seriesId: PIANO, startDatetimeUtc: '2026-08-08T22:15:00Z', endDatetimeUtc: '2026-08-08T22:30:00Z' }, 9);
const slot2 = scored({ id: 'b', seriesId: PIANO, startDatetimeUtc: '2026-08-08T22:30:00Z', endDatetimeUtc: '2026-08-08T22:45:00Z' }, 8);
const slot3 = scored({ id: 'c', seriesId: PIANO, startDatetimeUtc: '2026-08-09T02:15:00Z', endDatetimeUtc: '2026-08-09T02:30:00Z' }, 7);
const nextDay = scored({ id: 'd', seriesId: PIANO, startDatetimeUtc: '2026-08-09T22:15:00Z', endDatetimeUtc: '2026-08-09T22:30:00Z' }, 6);

describe('collapseSameDaySeries', () => {
  it('turns many slots of one series on one day into a single entry', () => {
    const groups = collapseSameDaySeries([slot1, slot2, slot3]);
    expect(groups).toHaveLength(1);
    expect(groups[0].slots.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the best-ranked slot as the card, and leaves it where it ranked', () => {
    const other = scored({ id: 'z', seriesId: 'series-other', startDatetimeUtc: '2026-08-08T23:00:00Z' }, 10);
    const groups = collapseSameDaySeries([other, slot1, slot2]);
    expect(groups.map((g) => g.representative.candidate.listing.id)).toEqual(['z', 'a']);
  });

  it('never merges across days', () => {
    // 2026-08-08T22:15Z is Aug 8 local; 2026-08-09T22:15Z is Aug 9 local. Same series, two cards.
    const groups = collapseSameDaySeries([slot1, nextDay]);
    expect(groups).toHaveLength(2);
  });

  it('groups by the LOCAL day, not the UTC one', () => {
    // 2026-08-09T02:15Z is 7:15 PM on Aug 8 in Vancouver — same local day as slot1, different UTC day.
    const groups = collapseSameDaySeries([slot1, slot3]);
    expect(groups).toHaveLength(1);
  });

  it('never merges different series that happen to share a day', () => {
    const otherSeries = scored({ id: 'x', seriesId: 'series-other', startDatetimeUtc: '2026-08-08T22:15:00Z' });
    expect(collapseSameDaySeries([slot1, otherSeries])).toHaveLength(2);
  });

  it('always gives a single occurrence a one-slot group, so consumers need no special case', () => {
    const groups = collapseSameDaySeries([slot1]);
    expect(groups[0].slots).toHaveLength(1);
    expect(groups[0].slots[0].id).toBe('a');
  });

  it('leaves open-hours and undated listings uncollapsed — they belong to no single day', () => {
    const openA = scored({ id: 'o1', seriesId: 'aquarium', startDatetimeUtc: null, endDatetimeUtc: null, openHours: true });
    const openB = scored({ id: 'o2', seriesId: 'aquarium', startDatetimeUtc: null, endDatetimeUtc: null, openHours: true });
    expect(collapseSameDaySeries([openA, openB])).toHaveLength(2);
  });

  it('sorts slots by start time regardless of the incoming order', () => {
    const groups = collapseSameDaySeries([slot2, slot1]);
    expect(groups[0].slots.map((s) => s.id)).toEqual(['a', 'b']);
    // …while the card itself is still the one that ranked first in the input.
    expect(groups[0].representative.candidate.listing.id).toBe('b');
  });

  it('preserves the exact input order of the entries it keeps', () => {
    const first = scored({ id: 'f', seriesId: 's1', startDatetimeUtc: '2026-08-08T20:00:00Z' });
    const second = scored({ id: 's', seriesId: 's2', startDatetimeUtc: '2026-08-08T18:00:00Z' });
    const groups = collapseSameDaySeries([first, second, slot1]);
    expect(groups.map((g) => g.representative.candidate.listing.id)).toEqual(['f', 's', 'a']);
  });
});

describe('slotSpanEnd', () => {
  it('returns the end of the last slot — the closing edge of the displayed span', () => {
    const groups = collapseSameDaySeries([slot1, slot2, slot3]);
    expect(slotSpanEnd(groups[0].slots)).toBe('2026-08-09T02:30:00Z');
  });

  it('falls back to a start time when the last slot has no end', () => {
    const noEnd = scored({ id: 'n', seriesId: PIANO, startDatetimeUtc: '2026-08-09T03:00:00Z', endDatetimeUtc: null });
    const groups = collapseSameDaySeries([slot1, noEnd]);
    expect(slotSpanEnd(groups[0].slots)).toBe('2026-08-09T03:00:00Z');
  });

  it('returns null when nothing in the group has a time at all', () => {
    expect(slotSpanEnd([{ id: 'x', startDatetimeUtc: null, endDatetimeUtc: null }])).toBeNull();
  });
});
