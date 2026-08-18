// A collapsed card may not state its representative's age as though it spoke for the whole group
// (P1-7a). The counterpart of tests/search/group-cost.test.ts for the other per-occurrence fact a
// collapsed card asserts on its face.
//
// THE BUG. `occurrence_age` is keyed per OCCURRENCE (supabase/migrations/0005_taxonomy.sql), so two
// sessions of one series on one day can carry different age bounds — an adults-only evening session
// beside an all-ages daytime one is the shape that was reported. `collapseSameDaySeries` kept the
// representative and carried only cost per-slot, so the card printed the representative's age for
// every member. Which occurrence is the representative is decided by rank+sort BEFORE collapse
// (lib/search/engine.ts) on grounds that have nothing to do with age, so when it happened to be the
// less-restrictive member the card published "All ages" for a group containing a session no child
// may attend.

import { describe, expect, it } from 'vitest';
import { collapseSameDaySeries } from '../../lib/search/collapse';
import { readGroupAge } from '../../lib/search/filters/age';
import type { ScoredListing } from '../../lib/search/rank';
import { makeListing } from '../../lib/search/__fixtures__/factory';
import type { ListingRecord } from '../../lib/search/types';
import { mapSearchItemToActivity } from '../../app/preview/_data/search-api';
import { AGES_VARY_BY_SESSION, AGE_NOT_STATED, formatCardAges } from '../../app/preview/_data/format';

function scored(overrides: Partial<ListingRecord> & { id: string }, score = 1): ScoredListing {
  return {
    candidate: { listing: makeListing(overrides), relevance: 1, matchedTerms: [], categoryHit: true },
    score,
    distanceKm: null,
    components: {} as ScoredListing['components'],
  };
}

const SERIES = 'series-gallery-tour';

// The reported shape: one series, one Vancouver day, two sessions. The daytime one is open to
// everyone; the evening one is adults-only. The all-ages session ranks first, so it is the
// representative — exactly the case where the old code under-claimed.
const allAges = scored(
  {
    id: 'daytime',
    seriesId: SERIES,
    startDatetimeUtc: '2026-08-08T18:00:00Z',
    endDatetimeUtc: '2026-08-08T20:00:00Z',
    ageMinMonths: 0,
    ageMaxMonths: null,
  },
  9,
);
const adultsOnly = scored(
  {
    id: 'evening',
    seriesId: SERIES,
    startDatetimeUtc: '2026-08-09T02:00:00Z', // 7 PM PDT, same local day
    endDatetimeUtc: '2026-08-09T04:00:00Z',
    ageMinMonths: 19 * 12,
    ageMaxMonths: null,
  },
  8,
);

describe('collapse carries every member’s own age bounds', () => {
  it('collapses the two sessions into one card (the grouping itself is unchanged)', () => {
    const groups = collapseSameDaySeries([allAges, adultsOnly]);
    expect(groups).toHaveLength(1);
    expect(groups[0].slots).toHaveLength(2);
  });

  it('puts each occurrence’s OWN age on its slot, not the representative’s', () => {
    const [group] = collapseSameDaySeries([allAges, adultsOnly]);
    const byId = new Map(group.slots.map((s) => [s.id, s]));
    expect(byId.get('daytime')).toMatchObject({ ageMinMonths: 0, ageMaxMonths: null });
    expect(byId.get('evening')).toMatchObject({ ageMinMonths: 228, ageMaxMonths: null });
  });
});

describe('readGroupAge', () => {
  it('states the shared bounds when every session agrees', () => {
    expect(readGroupAge([{ ageMinMonths: 60, ageMaxMonths: 108 }, { ageMinMonths: 60, ageMaxMonths: 108 }])).toEqual({
      kind: 'agreed',
      ageMinMonths: 60,
      ageMaxMonths: 108,
    });
  });

  it('leaves a single-session group exactly as it was — the fix must not touch a card that was fine', () => {
    expect(readGroupAge([{ ageMinMonths: 0, ageMaxMonths: null }])).toEqual({
      kind: 'agreed',
      ageMinMonths: 0,
      ageMaxMonths: null,
    });
  });

  it('declines to state a range when the sessions disagree', () => {
    expect(readGroupAge([{ ageMinMonths: 0, ageMaxMonths: null }, { ageMinMonths: 228, ageMaxMonths: null }])).toEqual({
      kind: 'varies',
    });
  });

  it('treats a stated age and an unstated one as a disagreement, not as agreement on the stated one', () => {
    expect(readGroupAge([{ ageMinMonths: 60, ageMaxMonths: 108 }, { ageMinMonths: null, ageMaxMonths: null }])).toEqual({
      kind: 'varies',
    });
  });

  it('is `agreed` on an empty group rather than inventing a disagreement', () => {
    expect(readGroupAge([])).toEqual({ kind: 'agreed', ageMinMonths: null, ageMaxMonths: null });
  });
});

describe('the card never under-claims a collapsed group’s age', () => {
  const [group] = collapseSameDaySeries([allAges, adultsOnly]);
  const activity = mapSearchItemToActivity({
    listing: group.representative.candidate.listing,
    distanceKm: null,
    slots: group.slots,
  });

  it('does NOT print the all-ages representative’s claim for a group containing a 19+ session', () => {
    // The regression itself. Before the fix this read "All ages".
    expect(formatCardAges(activity)).not.toBe('All ages');
    expect(activity.ageMin).toBeNull();
    expect(activity.ageMax).toBeNull();
  });

  it('says the ages vary, which is the true statement about what this card stands for', () => {
    expect(activity.agesVaryBySession).toBe(true);
    expect(formatCardAges(activity)).toBe(AGES_VARY_BY_SESSION);
  });

  it('does not pass a real disagreement off as "the source stated nothing"', () => {
    expect(formatCardAges(activity)).not.toBe(AGE_NOT_STATED);
  });

  it('leaves an agreeing group printing its range exactly as before', () => {
    const sameAge = [
      scored({ id: 'p', seriesId: 'series-piano', startDatetimeUtc: '2026-08-08T22:15:00Z', ageMinMonths: 60, ageMaxMonths: 108 }, 9),
      scored({ id: 'q', seriesId: 'series-piano', startDatetimeUtc: '2026-08-08T22:30:00Z', ageMinMonths: 60, ageMaxMonths: 108 }, 8),
    ];
    const [agreeing] = collapseSameDaySeries(sameAge);
    const card = mapSearchItemToActivity({
      listing: agreeing.representative.candidate.listing,
      distanceKm: null,
      slots: agreeing.slots,
    });
    expect(card.agesVaryBySession).toBeUndefined();
    // 108 months is the upper-EXCLUSIVE bound (age_band semantics), so the last included year is 8.
    expect(formatCardAges(card)).toBe('Ages 5–8');
  });

  it('leaves an uncollapsed single-session card printing its range exactly as before', () => {
    const single = mapSearchItemToActivity({
      listing: makeListing({ id: 'solo', ageMinMonths: 0, ageMaxMonths: null }),
      distanceKm: null,
    });
    expect(single.agesVaryBySession).toBeUndefined();
    expect(formatCardAges(single)).toBe('All ages');
  });
});
