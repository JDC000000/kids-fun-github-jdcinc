// Same-series collapsing (lib/search/collapse.ts).
//
// The rule the rest of the pipeline depends on: collapsing REMOVES REPEATS AND NOTHING ELSE.
// It must not reorder results (ranking and sort own position), must not merge across series, and
// must not touch listings that belong to no point in time.
//
// WHAT CHANGED, AND WHY THE OLD PIN IS GONE. This file used to assert 'never merges across days'.
// That was the whole defect the 2026-08-18 independent report measured as its P1-2: the same
// weekly programme filled a page one card per weekday ("…Delbrook Tuesday", "…Wednesday",
// "…Thursday", "…Friday"), so a 60-result page held about 8 real options. A recurring programme
// is ONE thing to decide about. What the old rule was protecting — that a card may not state a
// time span it does not occupy — is protected instead by `slotLocalDays` and its consumers:
// a card spanning days states its DAYS and no span at all (see engine.ts `slotSpanEndUtc`,
// format.ts#formatSlotSummary, and invariants/card-honesty.test.ts).

import { describe, expect, it } from 'vitest';
import { collapseSeries, slotLocalDays, slotSpanEnd } from '../../lib/search/collapse';
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

describe('collapseSeries', () => {
  it('turns many slots of one series on one day into a single entry', () => {
    const groups = collapseSeries([slot1, slot2, slot3]);
    expect(groups).toHaveLength(1);
    expect(groups[0].slots.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the best-ranked slot as the card, and leaves it where it ranked', () => {
    const other = scored({ id: 'z', seriesId: 'series-other', startDatetimeUtc: '2026-08-08T23:00:00Z' }, 10);
    const groups = collapseSeries([other, slot1, slot2]);
    expect(groups.map((g) => g.representative.candidate.listing.id)).toEqual(['z', 'a']);
  });

  it('merges the SAME series across days — one recurring programme is one card', () => {
    // 2026-08-08T22:15Z is Aug 8 local; 2026-08-09T22:15Z is Aug 9 local. One card, both slots.
    const groups = collapseSeries([slot1, nextDay]);
    expect(groups).toHaveLength(1);
    expect(groups[0].slots.map((s) => s.id)).toEqual(['a', 'd']);
  });

  it('reports every local day a card runs on, ascending and de-duplicated', () => {
    // slot1 + slot3 are both Aug 8 LOCAL (02:15Z on the 9th is 7:15 PM on the 8th in Vancouver);
    // `nextDay` is Aug 9 local. Three slots, two days.
    const groups = collapseSeries([slot1, slot3, nextDay]);
    expect(groups).toHaveLength(1);
    expect(slotLocalDays(groups[0].slots)).toEqual(['2026-08-08', '2026-08-09']);
  });

  it('reports ONE day for a card whose slots are all on the same local day', () => {
    const groups = collapseSeries([slot1, slot2, slot3]);
    expect(slotLocalDays(groups[0].slots)).toEqual(['2026-08-08']);
  });

  it('reports no day at all for a card that belongs to no point in time', () => {
    const open = scored({ id: 'o', seriesId: 'aquarium', startDatetimeUtc: null, endDatetimeUtc: null, openHours: true });
    expect(slotLocalDays(collapseSeries([open])[0].slots)).toEqual([]);
  });

  it('never merges different series that happen to share a day', () => {
    const otherSeries = scored({ id: 'x', seriesId: 'series-other', startDatetimeUtc: '2026-08-08T22:15:00Z' });
    expect(collapseSeries([slot1, otherSeries])).toHaveLength(2);
  });

  it('always gives a single occurrence a one-slot group, so consumers need no special case', () => {
    const groups = collapseSeries([slot1]);
    expect(groups[0].slots).toHaveLength(1);
    expect(groups[0].slots[0].id).toBe('a');
  });

  it('leaves open-hours and undated listings uncollapsed — they belong to no point in time', () => {
    const openA = scored({ id: 'o1', seriesId: 'aquarium', startDatetimeUtc: null, endDatetimeUtc: null, openHours: true });
    const openB = scored({ id: 'o2', seriesId: 'aquarium', startDatetimeUtc: null, endDatetimeUtc: null, openHours: true });
    expect(collapseSeries([openA, openB])).toHaveLength(2);
  });

  it('sorts slots by start time regardless of the incoming order', () => {
    const groups = collapseSeries([slot2, slot1]);
    expect(groups[0].slots.map((s) => s.id)).toEqual(['a', 'b']);
    // …while the card itself is still the one that ranked first in the input.
    expect(groups[0].representative.candidate.listing.id).toBe('b');
  });

  it('preserves the exact input order of the entries it keeps', () => {
    const first = scored({ id: 'f', seriesId: 's1', startDatetimeUtc: '2026-08-08T20:00:00Z' });
    const second = scored({ id: 's', seriesId: 's2', startDatetimeUtc: '2026-08-08T18:00:00Z' });
    const groups = collapseSeries([first, second, slot1]);
    expect(groups.map((g) => g.representative.candidate.listing.id)).toEqual(['f', 's', 'a']);
  });
});

describe('slotSpanEnd', () => {
  it('returns the end of the last slot — the closing edge of the displayed span', () => {
    const groups = collapseSeries([slot1, slot2, slot3]);
    expect(slotSpanEnd(groups[0].slots)).toBe('2026-08-09T02:30:00Z');
  });

  it('falls back to a start time when the last slot has no end', () => {
    const noEnd = scored({ id: 'n', seriesId: PIANO, startDatetimeUtc: '2026-08-09T03:00:00Z', endDatetimeUtc: null });
    const groups = collapseSeries([slot1, noEnd]);
    expect(slotSpanEnd(groups[0].slots)).toBe('2026-08-09T03:00:00Z');
  });

  it('returns null when nothing in the group has a time at all', () => {
    expect(
      slotSpanEnd([{ id: 'x', startDatetimeUtc: null, endDatetimeUtc: null, costStatus: 'unknown', costMinCad: null, costMaxCad: null }]),
    ).toBeNull();
  });
});
