// tests/search/filters.test.ts — Time-of-day (G-T16-4), cost (G-T16-5), status (G-T16-6) predicates.

import { describe, it, expect } from 'vitest';
import { matchesTimeOfDay, matchesDate } from '../../lib/search/filters/time';
import { matchesCost, isFree, isUnknownCost, type CostFilter } from '../../lib/search/filters/cost';
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

  // ── THE 22:00–05:00 GAP. The three chips used to span 05:00–22:00 and nothing else, so every
  // chip was guaranteed empty for anything happening late at night. Three testers opened the app
  // at 22:35 local, tapped Evening, saw nothing, and reported the product broken. `evening` now
  // runs to 05:00 the next morning — the hour `morning` opens — so the parts tile the clock.
  describe('the late-night window (the 22:35 repro)', () => {
    /** The UTC instant for a Vancouver-local wall-clock time on a PDT summer day (UTC-7). */
    const utcAt = (hh: number, mm: number) => Date.UTC(2026, 6, 13, hh + 7, mm);

    /** A one-hour occurrence starting at that local time — the shape a real listing has. */
    const at = (hh: number, mm = 0) =>
      makeListing({
        startDatetimeUtc: new Date(utcAt(hh, mm)).toISOString(),
        endDatetimeUtc: new Date(utcAt(hh, mm) + 60 * 60_000).toISOString(),
      });

    /**
     * A POINT occurrence at that local time (no end). Boundary claims have to be made about a
     * point, not a span: a one-hour 04:59 occurrence runs to 05:59 and therefore genuinely
     * belongs to evening AND morning, which says nothing about where the boundary sits.
     */
    const instant = (hh: number, mm = 0) =>
      makeListing({ startDatetimeUtc: new Date(utcAt(hh, mm)).toISOString(), endDatetimeUtc: null });

    const partsMatching = (l: ReturnType<typeof at>) =>
      (['morning', 'afternoon', 'evening'] as const).filter((p) => matchesTimeOfDay(l, p));

    it('THE REPRO — a 22:35 occurrence is reachable, and through the Evening chip', () => {
      expect(partsMatching(at(22, 35))).toEqual(['evening']);
    });

    it('every minute of the clock belongs to exactly one day-part — no gap, no overlap', () => {
      for (let minute = 0; minute < 24 * 60; minute += 1) {
        const hh = Math.floor(minute / 60);
        const parts = partsMatching(instant(hh, minute % 60));
        expect(
          parts,
          `local ${String(hh).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')} matched [${parts.join(', ')}]`,
        ).toHaveLength(1);
      }
    });

    it('past midnight is still "evening", not "morning"', () => {
      expect(partsMatching(instant(0, 30))).toEqual(['evening']);
      expect(partsMatching(instant(3, 0))).toEqual(['evening']);
    });

    it('04:59 is the last minute of evening and 05:00 the first of morning', () => {
      expect(partsMatching(instant(4, 59))).toEqual(['evening']);
      expect(partsMatching(instant(5, 0))).toEqual(['morning']);
    });

    it('an occurrence running 23:00→06:00 spans the boundary and matches BOTH ends', () => {
      // Only the backward clock-turn places this row's tail inside the next morning; a naive
      // comparison would report evening alone and hide it from a parent browsing at breakfast.
      const overnight = makeListing({
        startDatetimeUtc: '2026-07-14T06:00:00Z', // 23:00 local, 13 Jul
        endDatetimeUtc: '2026-07-14T13:00:00Z', // 06:00 local, 14 Jul
      });
      expect(partsMatching(overnight)).toEqual(['morning', 'evening']);
    });

    it('a late-night row is NOT dragged into a morning search by the adjacent-time rung', () => {
      // Evening's new reach must not make it a neighbour of morning: the broadening ladder's
      // whole point is that a parent asking for one end of the day is never handed the other.
      expect(matchesTimeOfDay(at(0, 30), 'morning', { includeAdjacent: true })).toBe(false);
      expect(matchesTimeOfDay(at(22, 35), 'morning', { includeAdjacent: true })).toBe(false);
      // …while evening's own adjacent window (afternoon + evening) still reaches them.
      expect(matchesTimeOfDay(at(0, 30), 'evening', { includeAdjacent: true })).toBe(true);
      expect(matchesTimeOfDay(at(14, 0), 'evening', { includeAdjacent: true })).toBe(true);
    });

    it('an open-hours venue whose published hours wrap midnight is open in the evening', () => {
      const lateVenue = makeListing({ openHours: true, openHoursLocal: { startMin: 20 * 60, endMin: 2 * 60 } });
      expect(matchesTimeOfDay(lateVenue, 'evening')).toBe(true);
      expect(matchesTimeOfDay(lateVenue, 'morning')).toBe(false);
      expect(matchesTimeOfDay(lateVenue, 'afternoon')).toBe(false);
    });
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

  it('unknown-cost is never CLASSIFIED as free — the honesty distinction survives', () => {
    // This is about what we CLAIM, not about what we show. `isFree` must stay strict: we do
    // not assert a price we were never given.
    expect(isFree(unknown)).toBe(false);
    expect(isUnknownCost(unknown)).toBe(true);
    expect(matchesCost(free, { free: true })).toBe(true);
  });

  it('unknown-cost listings are ALWAYS returned — with or without a free constraint', () => {
    // The behaviour this replaces: unknown-cost listings were hidden unless an
    // `includeUnknown` flag was set, and that flag defaulted differently in the /search state
    // layer (on) and the /api/search route (off). See lib/search/filters/cost.ts.
    expect(matchesCost(unknown, { free: false })).toBe(true);
    expect(matchesCost(unknown, { free: true })).toBe(true);
  });

  it('has NO max-cost ceiling left — price alone never excludes anything (Jon, 2026-08-11)', () => {
    // Replaces two tests that asserted a ceiling applied to known prices and never to unknown
    // ones. Jon removed the ceiling from the product outright, and it was removed here as the
    // ABSENCE of a parameter rather than an unreachable one (see lib/search/filters/cost.ts) —
    // so the assertion that carries the decision is that `free` is the only key CostFilter has.
    // A reintroduced `maxCad` would fail to type-check at every call site, which is the point.
    expect(matchesCost(paid, { free: false })).toBe(true); // $5, and nothing can cap it
    expect(matchesCost(makeListing({ costStatus: 'known', costMinCad: 500, costMaxCad: 500 }), { free: false })).toBe(true);
    // Type-level half, and the half with the real teeth: if `maxCad` is ever put back on
    // CostFilter this directive becomes unused and `tsc --noEmit` fails on it by name. A
    // runtime assertion cannot catch a parameter being re-added; this can.
    // @ts-expect-error — CostFilter carries no price ceiling any more (Jon, 2026-08-11).
    matchesCost(paid, { free: false, maxCad: 20 } satisfies CostFilter);
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
