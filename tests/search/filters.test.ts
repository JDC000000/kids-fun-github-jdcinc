// tests/search/filters.test.ts — Time-of-day (G-T16-4), cost (G-T16-5), status (G-T16-6) predicates.

import { describe, it, expect } from 'vitest';
import { matchesTimeOfDay, matchesDate } from '../../lib/search/filters/time';
import { matchesCost, isFree, isUnknownCost } from '../../lib/search/filters/cost';
import { isBookableNow, isRainyDayFriendly, isDropIn, isPrimaryResult, isExpectedSection, isHidden, matchesStatus } from '../../lib/search/filters/status';
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

  it('matchesDate range (T26/FR-04) includes every local day in [start, end] inclusive', () => {
    const d13 = makeListing({ startDatetimeUtc: '2026-07-13T17:00:00Z' }); // 2026-07-13 local
    const d14 = makeListing({ startDatetimeUtc: '2026-07-14T17:00:00Z' }); // 2026-07-14 local
    const d16 = makeListing({ startDatetimeUtc: '2026-07-16T17:00:00Z' }); // 2026-07-16 local
    const range = { kind: 'range' as const, isoDate: '2026-07-13', endIsoDate: '2026-07-15', weekday: null };
    expect(matchesDate(d13, range)).toBe(true); // start boundary
    expect(matchesDate(d14, range)).toBe(true); // interior
    expect(matchesDate(d16, range)).toBe(false); // past the end
    // Open-hours attractions are available every day → always inside a range.
    expect(matchesDate(makeListing({ openHours: true }), range)).toBe(true);
  });

  it('matchesDate range matches a single-day [X, X] range only on that day', () => {
    const d14 = makeListing({ startDatetimeUtc: '2026-07-14T17:00:00Z' });
    const single = { kind: 'range' as const, isoDate: '2026-07-14', endIsoDate: '2026-07-14', weekday: null };
    expect(matchesDate(d14, single)).toBe(true);
    expect(matchesDate(makeListing({ startDatetimeUtc: '2026-07-15T17:00:00Z' }), single)).toBe(false);
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

  it('Drop-in returns only listings carrying the drop_in tag, via either tag array (G-T21-3)', () => {
    expect(isDropIn(makeListing({ suitabilityTags: ['drop_in'] }))).toBe(true);
    expect(isDropIn(makeListing({ categoryTags: ['drop_in'] }))).toBe(true);
    expect(isDropIn(makeListing({ suitabilityTags: ['indoor'] }))).toBe(false);
    // The dropIn StatusFilter predicate gates a listing only when the chip is on.
    const dropIn = makeListing({ suitabilityTags: ['drop_in'] });
    const notDropIn = makeListing({ suitabilityTags: ['indoor'] });
    expect(matchesStatus(dropIn, { bookableNow: false, rainyDay: false, dropIn: true })).toBe(true);
    expect(matchesStatus(notDropIn, { bookableNow: false, rainyDay: false, dropIn: true })).toBe(false);
    expect(matchesStatus(notDropIn, { bookableNow: false, rainyDay: false })).toBe(true); // off → no gate
  });
});
