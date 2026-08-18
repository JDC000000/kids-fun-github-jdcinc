// tests/search/weekend-both-days.test.ts — "this weekend" is Saturday AND Sunday, from every day.
//
// THE RULING THIS FILE PINS (Jon, 2026-08-18): "this weekend always includes sunday... saturday
// and sundays are always a weekend together. very important that sunday is always included in the
// weekend search."
//
// THE BUG IT LOCKS OUT. `relativeDate('weekend')` resolved to ONE day via `(6 - wd + 7) % 7`, and
// `matchesDate` day-equality-matched anything that was not `kind === 'range'`. Two consequences,
// both parent-visible:
//   1. Sunday activities never appeared in a "this weekend" search, on any day of the week.
//   2. On a SUNDAY the formula read `(6 - 0 + 7) % 7 = 6` and threw the intent to NEXT Saturday —
//      a parent searching on Sunday morning was shown nothing that was on that very day.
//
// Every starting weekday is pinned below, not a spot check, because the defect was a formula
// that was right on six days and wrong on the seventh. A single-clock test would have passed
// against the broken code six times out of seven.

import { describe, it, expect } from 'vitest';
import { parseQuery, relativeDate } from '../../lib/search/parse';
import { matchesDate } from '../../lib/search/filters/time';
import { describeRequestedDay } from '../../lib/search/day-window';
import { makeListing } from '../../lib/search/__fixtures__/factory';

/**
 * Noon UTC-19:00 = noon America/Vancouver (PDT), one instant per weekday of the week containing
 * Sun 2026-08-16 → Sat 2026-08-22. That week's weekend pair is Sat 2026-08-22 + Sun 2026-08-23,
 * except on the Sunday that OPENS the week, whose own pair is Sat 2026-08-15 + Sun 2026-08-16.
 */
const WEEK: Array<{ day: string; nowUtc: string; from: string; to: string }> = [
  { day: 'Sunday',    nowUtc: '2026-08-16T19:00:00Z', from: '2026-08-15', to: '2026-08-16' }, // today IS the Sunday
  { day: 'Monday',    nowUtc: '2026-08-17T19:00:00Z', from: '2026-08-22', to: '2026-08-23' },
  { day: 'Tuesday',   nowUtc: '2026-08-18T19:00:00Z', from: '2026-08-22', to: '2026-08-23' },
  { day: 'Wednesday', nowUtc: '2026-08-19T19:00:00Z', from: '2026-08-22', to: '2026-08-23' },
  { day: 'Thursday',  nowUtc: '2026-08-20T19:00:00Z', from: '2026-08-22', to: '2026-08-23' },
  { day: 'Friday',    nowUtc: '2026-08-21T19:00:00Z', from: '2026-08-22', to: '2026-08-23' },
  { day: 'Saturday',  nowUtc: '2026-08-22T19:00:00Z', from: '2026-08-22', to: '2026-08-23' }, // today IS the Saturday
];

describe('relativeDate("weekend") — the nearest Saturday+Sunday pair, from every weekday', () => {
  it.each(WEEK)('$day resolves to $from..$to', ({ nowUtc, from, to }) => {
    expect(relativeDate('weekend', new Date(nowUtc))).toEqual({
      kind: 'weekend',
      isoDate: from,
      endIsoDate: to,
      weekday: 6,
    });
  });

  it('never resolves to a bare Saturday — every weekday declares an end date one day later', () => {
    // The regression in one assertion: a single-day weekend has no `endIsoDate`, and
    // `matchesDate` then narrows to the start day. Sunday cannot be dropped without this failing.
    for (const { day, nowUtc } of WEEK) {
      const intent = relativeDate('weekend', new Date(nowUtc));
      expect(intent.endIsoDate, `${day} resolved a weekend with no Sunday side`).toBeTruthy();
      expect(new Date(`${intent.endIsoDate}T12:00:00Z`).getUTCDay(), `${day}'s end is not a Sunday`).toBe(0);
      expect(new Date(`${intent.isoDate}T12:00:00Z`).getUTCDay(), `${day}'s start is not a Saturday`).toBe(6);
    }
  });

  it('on the DST fall-back Sunday, "this weekend" is THAT Sunday — not next Saturday', () => {
    // The measured failure. 2026-11-01T08:30:00Z is 01:30 America/Vancouver on the fall-back
    // Sunday (01:30 local happens twice that day), and the old code resolved it to 2026-11-07:
    // six days forward, past the Sunday the parent was standing in.
    const intent = relativeDate('weekend', new Date('2026-11-01T08:30:00Z'));
    expect(intent).toEqual({ kind: 'weekend', isoDate: '2026-10-31', endIsoDate: '2026-11-01', weekday: 6 });
    expect(intent.endIsoDate).not.toBe('2026-11-07');
  });

  it('derives the pair from the VANCOUVER day, not the UTC day', () => {
    // 23:35 Saturday local is already Sunday in UTC. The weekend is still Sat 22nd + Sun 23rd:
    // reading the UTC day here would have shifted it a full week for a parent searching at night.
    expect(relativeDate('weekend', new Date('2026-08-23T06:35:00Z'))).toMatchObject({
      isoDate: '2026-08-22',
      endIsoDate: '2026-08-23',
    });
  });

  it('the typed `when` param and the typed phrase resolve identically', () => {
    // engine.ts's Stage 2a `when` override and the text parser must never disagree about a date.
    for (const { day, nowUtc } of WEEK) {
      const now = new Date(nowUtc);
      expect(parseQuery('swim this weekend', { now }).date, day).toEqual(relativeDate('weekend', now));
      expect(parseQuery('swim weekend', { now }).date, day).toEqual(relativeDate('weekend', now));
    }
  });
});

describe('matchesDate over a weekend intent — Sunday is IN, the flanking weekdays are not', () => {
  const weekend = relativeDate('weekend', new Date('2026-08-18T19:00:00Z')); // Tue → 22nd..23rd
  const at = (iso: string) => makeListing({ startDatetimeUtc: `${iso}T19:00:00Z` }); // noon local

  it('matches the Saturday', () => {
    expect(matchesDate(at('2026-08-22'), weekend)).toBe(true);
  });

  it('matches the Sunday — the whole point of the fix', () => {
    expect(matchesDate(at('2026-08-23'), weekend)).toBe(true);
  });

  it('does not match the Friday before or the Monday after', () => {
    expect(matchesDate(at('2026-08-21'), weekend)).toBe(false);
    expect(matchesDate(at('2026-08-24'), weekend)).toBe(false);
  });

  it('on a Sunday, today is matched and the already-past Saturday is left to the read-model prune', () => {
    // The intent deliberately still SPANS the finished Saturday: `visibleOccurrenceWhereSql()`
    // drops ended occurrences before any filter runs, exactly as it already does for `today`, so
    // a second prune here would be a divergent copy of the same rule. What must hold is that the
    // Sunday — the day the parent is actually standing in — is inside the window.
    const sunday = relativeDate('weekend', new Date('2026-08-16T19:00:00Z')); // 15th..16th
    expect(matchesDate(at('2026-08-16'), sunday)).toBe(true);
    expect(matchesDate(at('2026-08-15'), sunday)).toBe(true);
  });

  it('open-hours attractions are available across the whole weekend', () => {
    expect(matchesDate(makeListing({ openHours: true }), weekend)).toBe(true);
  });
});

describe('a weekend gets no single-day clock verdict', () => {
  it('describeRequestedDay declines a weekend, as it declines any multi-day window', () => {
    // DECISION, PINNED. `day-window.ts` answers "how much of the requested day is still ahead?",
    // and a Sat+Sun window has no one answer — at 11pm on Saturday the Saturday is over while the
    // Sunday is entirely ahead. It used to get a verdict only because the intent was one day; now
    // that it is two, null is the honest result rather than a lost feature.
    const weekend = relativeDate('weekend', new Date('2026-08-22T19:00:00Z')); // Sat → 22nd..23rd
    expect(describeRequestedDay(weekend, new Date('2026-08-23T06:35:00Z'))).toBeNull();
    // …while a single-day intent still gets one, so this is a claim about SPAN, not about weekends.
    expect(describeRequestedDay({ kind: 'today', isoDate: '2026-08-22', weekday: null }, new Date('2026-08-23T06:35:00Z')))
      .toMatchObject({ isToday: true, state: 'day_over' });
  });
});
