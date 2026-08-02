// tests/search/vancouver-time.test.ts — America/Vancouver decomposition + its memo.
//
// toVancouverParts is on the hot path of every date/time-of-day predicate, every ranking
// pass and every facet count, so it caches its (deterministic) result per instant. These
// tests pin the two things that cache could plausibly break: DST correctness, and the
// isolation of the shared, cached object.

import { describe, it, expect } from 'vitest';
import { toVancouverParts, localIsoDate, localMinutesOfDay } from '../../lib/search/time/vancouver';

describe('toVancouverParts', () => {
  it('converts UTC to Vancouver-local parts', () => {
    const parts = toVancouverParts(new Date('2026-07-13T17:00:00Z'));
    expect(parts).toMatchObject({ year: 2026, month: 7, day: 13, hour: 10, minute: 0, isoDate: '2026-07-13' });
    expect(parts.weekday).toBe(1); // Monday
  });

  it('is DST-correct on both sides of a transition (PST -8 vs PDT -7)', () => {
    // 2026 transitions: 08 Mar (spring forward) and 01 Nov (fall back).
    expect(localIsoDate(new Date('2026-03-08T09:00:00Z'))).toBe('2026-03-08');
    expect(localMinutesOfDay(new Date('2026-01-15T20:00:00Z'))).toBe(12 * 60); // PST: UTC-8
    expect(localMinutesOfDay(new Date('2026-07-15T19:00:00Z'))).toBe(12 * 60); // PDT: UTC-7
  });

  it('rolls the local date back for an instant that is still "yesterday" in Vancouver', () => {
    expect(localIsoDate(new Date('2026-07-14T06:00:00Z'))).toBe('2026-07-13'); // 23:00 local
  });

  it('returns a stable, identical answer for a repeated instant (the memo is transparent)', () => {
    const instant = () => new Date('2026-07-13T21:30:00Z');
    expect(toVancouverParts(instant())).toEqual(toVancouverParts(instant()));
    // Distinct Date objects for the same moment must resolve identically — the memo keys on
    // the instant, not on object identity.
    expect(toVancouverParts(new Date(1_784_000_000_000))).toEqual(toVancouverParts(new Date(1_784_000_000_000)));
  });

  it('hands out a frozen object, so one caller can never corrupt another\'s reading', () => {
    const parts = toVancouverParts(new Date('2026-07-13T17:00:00Z'));
    expect(Object.isFrozen(parts)).toBe(true);
    expect(() => {
      (parts as { hour: number }).hour = 99;
    }).toThrow();
    expect(toVancouverParts(new Date('2026-07-13T17:00:00Z')).hour).toBe(10);
  });

  it('stays correct past the cache cap — an evicted instant re-derives the same parts', () => {
    const before = toVancouverParts(new Date('2026-07-13T17:00:00Z'));
    // Overflow the bounded cache with distinct instants (cap is 4096).
    const base = Date.UTC(2020, 0, 1);
    for (let i = 0; i < 5000; i += 1) toVancouverParts(new Date(base + i * 60_000));
    expect(toVancouverParts(new Date('2026-07-13T17:00:00Z'))).toEqual(before);
  });

  it('still rejects an invalid date rather than caching nonsense', () => {
    expect(() => toVancouverParts(new Date('not-a-date'))).toThrow(RangeError);
  });
});
