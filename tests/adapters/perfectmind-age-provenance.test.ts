// tests/adapters/perfectmind-age-provenance.test.ts — the age provenance this adapter has
// always computed and always thrown away.
//
// resolveAgeText() decides between EIGHT different inputs and reports which one won. Until
// now that verdict was folded into three integers (`ageDeterministic` / `ageFromDisplayText`
// / `ageUnresolved`) and the per-record `reason` had no reader anywhere in the repo, so a run
// where every age came from the vendor's structured `MinAge`/`MaxAge` numbers and a run where
// every age came from `NoAgeRestriction` produced byte-identical accounting.
//
// So the test that matters here is NOT "does the new field exist" — it is that two runs the
// old counters call identical are now told apart. That is what `differentiates the verdict
// types the rollup collapses` below asserts, and it is the only assertion in this file that
// would fail against a breakdown keyed on something too coarse to be useful.
//
// The first block is the guard on the other half of the change: this was additive, so every
// ageText/deterministic/reason the adapter emitted before must still be emitted, unchanged,
// for all eight verdict types.
import { describe, it, expect } from 'vitest';
import {
  AGE_SIGNAL_CODES,
  emptyAgeSignalCounts,
  emptyStats,
  parseTenantCalendars,
  resolveAgeText,
  type AgeSignalCode,
} from '../../worker/adapters/perfectmind/parse';
import { CLASSES_BOOKING_TYPE, type BookMe4Class, type CalendarFetchResult } from '../../worker/adapters/perfectmind/client';
import { getPerfectMindTenant } from '../../worker/adapters/perfectmind/config';
import { parseAgeText } from '../../worker/core/age';

const nvrc = getPerfectMindTenant('nvrc')!;
const DROP_IN_CATEGORY = nvrc.dropInCategoryNames[0];
const WINDOW = { startDate: '2026-08-01', endDate: '2026-08-31' };

function classRecord(over: Partial<BookMe4Class> = {}): BookMe4Class {
  return {
    EventId: 'evt-1',
    EventName: 'Open Gym',
    OccurrenceDate: '20260814',
    EventTimeDescription: '10:00 am - 11:30 am',
    AllDayEvent: false,
    Facility: 'Gymnasium',
    Location: 'Delbrook Community Recreation Centre',
    BookButtonText: 'More Info',
    ...over,
  };
}

function calendarOf(classes: BookMe4Class[]): CalendarFetchResult {
  return {
    calendarId: 'cal-1',
    calendarName: 'Open Gym Schedules',
    categoryName: DROP_IN_CATEGORY,
    bookingType: CLASSES_BOOKING_TYPE,
    classes,
    occurrenceCount: classes.length,
    pagesFetched: 1,
    stridesWalked: 1,
    truncated: false,
    warnings: [],
  };
}

/** One input per verdict type, with the output the adapter produced BEFORE this change. */
const CASES: Array<{
  code: AgeSignalCode;
  input: Partial<BookMe4Class>;
  ageText: string | undefined;
  deterministic: boolean;
  reason: string;
}> = [
  {
    code: 'no-age-restriction',
    input: { NoAgeRestriction: true },
    ageText: 'All ages',
    deterministic: true,
    reason: 'NoAgeRestriction',
  },
  {
    code: 'structured-min-max',
    input: { MinAge: 5, MaxAge: 12, NoAgeRestriction: false },
    ageText: 'ages 5-12',
    deterministic: true,
    reason: 'structured MinAge/MaxAge',
  },
  {
    code: 'structured-min-open',
    // The measured vendor quirk: MinAge 7 + MinAgeMonths 12 is 8 years, max 0/0 is "none".
    input: { MinAge: 7, MinAgeMonths: 12, MaxAge: 0, MaxAgeMonths: 0, NoAgeRestriction: false },
    ageText: 'ages 8 years and up',
    deterministic: true,
    reason: 'structured MinAge, no maximum',
  },
  {
    code: 'structured-min-incoherent-max',
    // A max BELOW the min is not a range the vendor meant — it is dropped, and this is the
    // one verdict type where the adapter discards something it was given.
    input: { MinAge: 10, MaxAge: 4, NoAgeRestriction: false },
    ageText: 'ages 10 years and up',
    deterministic: true,
    reason: 'structured MinAge (incoherent maximum ignored)',
  },
  {
    code: 'structured-max-only',
    input: { MinAge: null, MaxAge: 5, NoAgeRestriction: false },
    ageText: 'under 6',
    deterministic: true,
    reason: 'structured MaxAge only',
  },
  {
    code: 'display-restrictions',
    input: { DisplayableRestrictionsForCourses: 'Age: 8+' },
    ageText: 'ages 8+',
    deterministic: false,
    reason: 'DisplayableRestrictionsForCourses',
  },
  {
    code: 'age-restrictions',
    input: { AgeRestrictions: '6 to 10' },
    ageText: 'ages 6 to 10',
    deterministic: false,
    reason: 'AgeRestrictions',
  },
  {
    code: 'none',
    input: {},
    ageText: undefined,
    deterministic: false,
    reason: 'no age signal',
  },
];

describe('perfectmind age provenance — the verdict itself is unchanged', () => {
  it.each(CASES)('$code emits the same ageText, deterministic flag and reason as before', (c) => {
    const verdict = resolveAgeText(classRecord(c.input));
    expect(verdict.ageText, 'ageText is what T13 parses — this change must not touch it').toBe(c.ageText);
    expect(verdict.deterministic).toBe(c.deterministic);
    expect(verdict.reason).toBe(c.reason);
    expect(verdict.code).toBe(c.code);
  });

  it('still hands T13 a phrase it resolves, for every verdict type that emits one', () => {
    for (const c of CASES.filter((x) => x.ageText !== undefined)) {
      expect(parseAgeText(resolveAgeText(classRecord(c.input)).ageText).resolved, c.code).toBe(true);
    }
  });

  it('covers every declared code — a new verdict type cannot be added untested', () => {
    expect(CASES.map((c) => c.code).sort()).toEqual([...AGE_SIGNAL_CODES].sort());
  });
});

describe('perfectmind age provenance — the run-level breakdown', () => {
  it('differentiates the verdict types the rollup collapses', () => {
    // Two runs the OLD counters cannot tell apart: five records each, all deterministic,
    // ageFromDisplayText 0, ageUnresolved 0.
    const allStructuredBounds = parseTenantCalendars(
      nvrc,
      [calendarOf([1, 2, 3, 4, 5].map((i) => classRecord({ EventId: `a-${i}`, MinAge: 5, MaxAge: 12, NoAgeRestriction: false })))],
      { window: WINDOW }
    ).stats;
    const allNoRestriction = parseTenantCalendars(
      nvrc,
      [calendarOf([1, 2, 3, 4, 5].map((i) => classRecord({ EventId: `b-${i}`, NoAgeRestriction: true })))],
      { window: WINDOW }
    ).stats;

    // The premise: indistinguishable under the rollups.
    expect(allStructuredBounds.ageDeterministic).toBe(allNoRestriction.ageDeterministic);
    expect(allStructuredBounds.ageFromDisplayText).toBe(allNoRestriction.ageFromDisplayText);
    expect(allStructuredBounds.ageUnresolved).toBe(allNoRestriction.ageUnresolved);

    // The point: distinguishable now. "Every age is a parsed numeric range" and "every age
    // is the vendor waiving age entirely" are different facts about a municipality.
    expect(allStructuredBounds.ageSignalCounts).not.toEqual(allNoRestriction.ageSignalCounts);
    expect(allStructuredBounds.ageSignalCounts['structured-min-max']).toBe(5);
    expect(allStructuredBounds.ageSignalCounts['no-age-restriction']).toBe(0);
    expect(allNoRestriction.ageSignalCounts['no-age-restriction']).toBe(5);
    expect(allNoRestriction.ageSignalCounts['structured-min-max']).toBe(0);
  });

  it('counts a mixed calendar per verdict type', () => {
    const { stats } = parseTenantCalendars(
      nvrc,
      [
        calendarOf(
          CASES.map((c, i) => classRecord({ EventId: `mix-${i}`, ...c.input })).concat(
            classRecord({ EventId: 'mix-dup', NoAgeRestriction: true })
          )
        ),
      ],
      { window: WINDOW }
    );

    for (const c of CASES) {
      const expected = c.code === 'no-age-restriction' ? 2 : 1;
      expect(stats.ageSignalCounts[c.code], c.code).toBe(expected);
    }

    // The rollups stay honest: they are exactly this breakdown, summed.
    const total = Object.values(stats.ageSignalCounts).reduce((a, b) => a + b, 0);
    expect(total).toBe(stats.recordsEmitted);
    expect(stats.ageDeterministic + stats.ageFromDisplayText + stats.ageUnresolved).toBe(total);
    expect(stats.ageFromDisplayText, 'the two free-text codes').toBe(
      stats.ageSignalCounts['display-restrictions'] + stats.ageSignalCounts['age-restrictions']
    );
    expect(stats.ageUnresolved).toBe(stats.ageSignalCounts.none);
  });

  it('zero-fills every code, so "never fired" cannot read as "no longer exists"', () => {
    // A rule that stopped firing is a finding; an absent key looks like a schema change.
    expect(Object.keys(emptyAgeSignalCounts()).sort()).toEqual([...AGE_SIGNAL_CODES].sort());
    expect(Object.values(emptyStats().ageSignalCounts).every((n) => n === 0)).toBe(true);

    const { stats } = parseTenantCalendars(nvrc, [calendarOf([classRecord({ NoAgeRestriction: true })])], { window: WINDOW });
    for (const code of AGE_SIGNAL_CODES) {
      expect(stats.ageSignalCounts[code], code).toBe(code === 'no-age-restriction' ? 1 : 0);
    }
  });
});
