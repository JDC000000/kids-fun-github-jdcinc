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
    // T1.1 (2026-09-10): was `code: 'no-age-restriction'`, `ageText: 'All ages'`,
    // `deterministic: true` — the manufactured claim. The vendor flag is unchanged; what
    // changed is that it no longer produces an age. Suppression is now unconditional rather
    // than requiring a contradicting title, so this row and the one below differ only in
    // WHY they withheld, which is exactly what the two codes are for.
    code: 'no-age-restriction-withheld',
    input: { NoAgeRestriction: true },
    ageText: undefined,
    deterministic: false,
    reason: 'NoAgeRestriction is a booking-system flag, not a statement about age',
  },
  {
    // T1.1's carve-out (2026-09-10). The vendor flag is set AND the venue publishes its own
    // "All Ages" copy in the title — two real measured NVRC records, "$2 Queer All Ages
    // Skate" and "$2 Queer All Ages Swim". This is the ONE arm of the flag branch that still
    // emits an age, and it must: the claim is the source's, not ours. `deterministic: false`
    // because a title is a display string, so it files under ageFromDisplayText.
    code: 'title-publishes-all-ages',
    input: { NoAgeRestriction: true, EventName: '$2 Queer All Ages Skate Karen Magnussen Monday 2:30-3:45pm' },
    ageText: 'All ages',
    deterministic: false,
    reason: 'the title publishes an all-ages claim of its own',
  },
  {
    // Added after the fact and NOT part of the "unchanged" premise this file was written
    // around: this verdict type did not exist when the eight above were pinned. It is listed
    // here because the coverage assertion below refuses any code without a case; its
    // behaviour is owned by perfectmind.test.ts's contradiction block.
    code: 'no-age-restriction-contradicted',
    input: { NoAgeRestriction: true, EventName: 'Adult 19yrs+ Swim Karen Magnussen Monday 8:00-9:00am' },
    ageText: undefined,
    deterministic: false,
    reason: 'NoAgeRestriction contradicted by an age stated in the title',
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

    // ⚠ THE ORIGINAL PREMISE OF THIS TEST IS SUPERSEDED BY T1.1, and pretending otherwise
    // would be the contortion. It was written when both runs came out "5 deterministic, 0
    // unresolved" and were therefore invisible to the coarse counters — that was the argument
    // for ageSignalCounts existing at all. Since the vendor flag stopped manufacturing a
    // claim, these two runs differ in the coarse counters too, which is a T1.1 improvement
    // worth asserting rather than a fact to work around.
    expect(allStructuredBounds.ageDeterministic, 'structured bounds are a real age').toBe(5);
    expect(allStructuredBounds.ageUnresolved).toBe(0);
    expect(allNoRestriction.ageDeterministic, 'the flag alone asserts nothing').toBe(0);
    expect(allNoRestriction.ageUnresolved).toBe(5);
    expect(allStructuredBounds.ageFromDisplayText).toBe(allNoRestriction.ageFromDisplayText);

    // The point: distinguishable now. "Every age is a parsed numeric range" and "every age
    // is the vendor waiving age entirely" are different facts about a municipality.
    expect(allStructuredBounds.ageSignalCounts).not.toEqual(allNoRestriction.ageSignalCounts);
    expect(allStructuredBounds.ageSignalCounts['structured-min-max']).toBe(5);
    expect(allStructuredBounds.ageSignalCounts['no-age-restriction-withheld']).toBe(0);
    expect(allNoRestriction.ageSignalCounts['no-age-restriction-withheld']).toBe(5);
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
      const expected = c.code === 'no-age-restriction-withheld' ? 2 : 1;
      expect(stats.ageSignalCounts[c.code], c.code).toBe(expected);
    }

    // The rollups stay honest: they are exactly this breakdown, summed.
    const total = Object.values(stats.ageSignalCounts).reduce((a, b) => a + b, 0);
    expect(total).toBe(stats.recordsEmitted);
    expect(stats.ageDeterministic + stats.ageFromDisplayText + stats.ageUnresolved).toBe(total);
    // THREE free-text codes as of T1.1: `title-publishes-all-ages` emits an ageText from a
    // title, which is a display string like the other two, so it belongs on this side of the
    // ledger and not in ageDeterministic. Same invariant, one more term.
    expect(stats.ageFromDisplayText, 'every code that emits a non-structured ageText').toBe(
      stats.ageSignalCounts['display-restrictions'] +
        stats.ageSignalCounts['age-restrictions'] +
        stats.ageSignalCounts['title-publishes-all-ages']
    );
    // THREE codes emit no ageText as of T1.1, not two: `no-age-restriction-withheld` joined
    // them when suppression became unconditional. This assertion is the invariant that
    // `ageUnresolved` is exactly the sum of the silent codes — if a fourth is ever added and
    // this is not updated, the rollup stops adding up and this is the test that says so.
    expect(stats.ageUnresolved, 'every code that emits no ageText').toBe(
      stats.ageSignalCounts.none +
        stats.ageSignalCounts['no-age-restriction-contradicted'] +
        stats.ageSignalCounts['no-age-restriction-withheld']
    );
  });

  it('zero-fills every code, so "never fired" cannot read as "no longer exists"', () => {
    // A rule that stopped firing is a finding; an absent key looks like a schema change.
    expect(Object.keys(emptyAgeSignalCounts()).sort()).toEqual([...AGE_SIGNAL_CODES].sort());
    expect(Object.values(emptyStats().ageSignalCounts).every((n) => n === 0)).toBe(true);

    const { stats } = parseTenantCalendars(nvrc, [calendarOf([classRecord({ NoAgeRestriction: true })])], { window: WINDOW });
    for (const code of AGE_SIGNAL_CODES) {
      expect(stats.ageSignalCounts[code], code).toBe(code === 'no-age-restriction-withheld' ? 1 : 0);
    }
  });
});
