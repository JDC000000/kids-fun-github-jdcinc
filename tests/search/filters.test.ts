// tests/search/filters.test.ts — Time-of-day (G-T16-4), cost (G-T16-5), status (G-T16-6) predicates.

import { describe, it, expect } from 'vitest';
import { matchesTimeOfDay, matchesDate } from '../../lib/search/filters/time';
import { matchesCost, isFree, isUnknownCost } from '../../lib/search/filters/cost';
import { isBookableNow, isRainyDayFriendly, isPrimaryResult, isExpectedSection, isHidden } from '../../lib/search/filters/status';
import { makeListing } from '../../lib/search/__fixtures__/factory';

describe('time-of-day filter (FR-09, G-T16-4)', () => {
  it('a 10:00 local occurrence matches "morning"', () => {
    const l = makeListing({ startDatetimeUtc: '2026-07-13T17:00:00Z', endDatetimeUtc: '2026-07-13T18:00:00Z' }); // 10:00–11:00 PDT
    expect(matchesTimeOfDay(l, 'morning')).toBe(true);
    expect(matchesTimeOfDay(l, 'evening')).toBe(false);
  });

  it('an open-hours 09:00–17:00 attraction intersects "afternoon"', () => {
    const l = makeListing({ openHours: true, openHoursLocal: { startMin: 9 * 60, endMin: 17 * 60 } });
    expect(matchesTimeOfDay(l, 'afternoon')).toBe(true);
    expect(matchesTimeOfDay(l, 'evening')).toBe(false);
  });

  it('matchesDate restricts fixed occurrences to the local date but always passes open-hours', () => {
    const fixed = makeListing({ startDatetimeUtc: '2026-07-13T17:00:00Z' }); // 2026-07-13 local
    expect(matchesDate(fixed, { kind: 'today', isoDate: '2026-07-13', weekday: null })).toBe(true);
    expect(matchesDate(fixed, { kind: 'today', isoDate: '2026-07-14', weekday: null })).toBe(false);
    const open = makeListing({ openHours: true });
    expect(matchesDate(open, { kind: 'today', isoDate: '2026-07-14', weekday: null })).toBe(true);
  });
});

describe('cost filter (FR-10/BR-11, G-T16-5)', () => {
  const free = makeListing({ costStatus: 'free' });
  const unknown = makeListing({ costStatus: 'unknown' });
  const paid = makeListing({ costStatus: 'known', costMinCad: 5, costMaxCad: 5 });

  it('"free" excludes unknown-cost (unknown is never free)', () => {
    expect(isFree(unknown)).toBe(false);
    expect(isUnknownCost(unknown)).toBe(true);
    expect(matchesCost(free, { free: true, includeUnknown: false })).toBe(true);
    expect(matchesCost(unknown, { free: true, includeUnknown: false })).toBe(false);
  });

  it('include-unknown surfaces unknown-cost listings', () => {
    expect(matchesCost(unknown, { free: true, includeUnknown: true })).toBe(true);
    // with no free constraint, unknown is hidden unless included
    expect(matchesCost(unknown, { free: false, includeUnknown: false })).toBe(false);
    expect(matchesCost(unknown, { free: false, includeUnknown: true })).toBe(true);
  });

  it('applies a max-cost ceiling to known prices', () => {
    expect(matchesCost(paid, { free: false, includeUnknown: false, maxCad: 3 })).toBe(false);
    expect(matchesCost(paid, { free: false, includeUnknown: false, maxCad: 10 })).toBe(true);
  });
});

describe('status predicates (G-T16-6)', () => {
  it('Bookable Now returns only bookable_open', () => {
    expect(isBookableNow(makeListing({ statusState: 'bookable_open' }))).toBe(true);
    expect(isBookableNow(makeListing({ statusState: 'confirmed' }))).toBe(false);
  });

  it('Rainy-day returns indoor listings, via either the indoor or rainy_day tag (Track B vocab)', () => {
    expect(isRainyDayFriendly(makeListing({ suitabilityTags: ['indoor'] }))).toBe(true);
    expect(isRainyDayFriendly(makeListing({ categoryTags: ['rainy_day'] }))).toBe(true); // Track B context tag
    expect(isRainyDayFriendly(makeListing({ suitabilityTags: ['outdoor'] }))).toBe(false);
  });

  it('classifies statuses into primary / expected / hidden', () => {
    expect(isPrimaryResult(makeListing({ statusState: 'confirmed' }))).toBe(true);
    expect(isExpectedSection(makeListing({ statusState: 'seasonal_out_of_season' }))).toBe(true);
    expect(isHidden(makeListing({ statusState: 'cancelled' }))).toBe(true);
  });
});
