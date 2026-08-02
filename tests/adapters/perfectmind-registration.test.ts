// tests/adapters/perfectmind-registration.test.ts — Option A: the drop-in/registration
// verdict PerfectMind has always computed and never written down.
//
// These tests are about a BEHAVIOUR change, not about the field existing: every case below
// distinguishes an outcome the pre-change adapter could not produce. The three-way split
// (false / true / undefined) is the whole point — a two-valued version of this feature
// would pass a "does it emit a boolean" test while quietly publishing "this is drop-in" for
// every record it knows nothing about.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  calendarAssertsDropIn,
  parseTenantCalendars,
  recordAssertsRegistration,
  resolveRegistrationRequired,
} from '../../worker/adapters/perfectmind/parse';
import { CLASSES_BOOKING_TYPE, type BookMe4Class, type CalendarFetchResult } from '../../worker/adapters/perfectmind/client';
import { getPerfectMindTenant } from '../../worker/adapters/perfectmind/config';

const nvrc = getPerfectMindTenant('nvrc')!;
const DROP_IN_CATEGORY = nvrc.dropInCategoryNames[0];

function classRecord(over: Partial<BookMe4Class> = {}): BookMe4Class {
  return {
    EventId: 'evt-1',
    EventName: '$3 Open Gym 8yrs+ Delbrook',
    OccurrenceDate: '20260814',
    EventTimeDescription: '10:00 am - 11:30 am',
    AllDayEvent: false,
    Facility: 'Gymnasium',
    Location: 'Delbrook Community Recreation Centre',
    Spots: '',
    BookButtonText: 'More Info',
    ...over,
  };
}

function calendar(over: Partial<CalendarFetchResult> = {}): CalendarFetchResult {
  return {
    calendarId: 'cal-1',
    calendarName: 'Open Gym Schedules',
    categoryName: DROP_IN_CATEGORY,
    bookingType: CLASSES_BOOKING_TYPE,
    classes: [classRecord()],
    occurrenceCount: 1,
    pagesFetched: 1,
    stridesWalked: 1,
    truncated: false,
    warnings: [],
    ...over,
  };
}

const WINDOW = { startDate: '2026-08-01', endDate: '2026-08-31' };

describe('perfectmind — the calendar-level drop-in assertion', () => {
  it('asserts drop-in only when BOTH the category name AND BookingType agree', () => {
    expect(calendarAssertsDropIn(nvrc, { categoryName: DROP_IN_CATEGORY, bookingType: CLASSES_BOOKING_TYPE })).toBe(true);

    // BookingType 3 is the REGISTERED Courses surface. A calendar filed under a drop-in
    // category name but served by the courses surface must not be called drop-in.
    expect(calendarAssertsDropIn(nvrc, { categoryName: DROP_IN_CATEGORY, bookingType: 3 })).toBe(false);
    // Right surface, wrong category — every Classes calendar the tenant publishes has
    // BookingType 2, so this half alone asserts nothing.
    expect(calendarAssertsDropIn(nvrc, { categoryName: 'Fitness: Yoga & Pilates', bookingType: CLASSES_BOOKING_TYPE })).toBe(false);
    // Fails CLOSED on missing data rather than assuming the happy path.
    expect(calendarAssertsDropIn(nvrc, { categoryName: DROP_IN_CATEGORY, bookingType: undefined })).toBe(false);
    expect(calendarAssertsDropIn(nvrc, { categoryName: undefined, bookingType: CLASSES_BOOKING_TYPE })).toBe(false);
  });

  it('writes registrationRequired=false onto records from a real drop-in calendar', () => {
    const { records, stats } = parseTenantCalendars(nvrc, [calendar()], { window: WINDOW });
    expect(records).toHaveLength(1);
    // FALSE, not undefined: the source positively says you can turn up.
    expect(records[0].registrationRequired).toBe(false);
    expect(stats.registrationDropIn).toBe(1);
    expect(stats.registrationRequired).toBe(0);
    expect(stats.registrationUnknown).toBe(0);
  });

  it('leaves registrationRequired UNSET — never false — when the calendar cannot be placed', () => {
    const unplaceable = calendar({ categoryName: 'Fitness: Yoga & Pilates' });
    const { records, stats } = parseTenantCalendars(nvrc, [unplaceable], { window: WINDOW });
    expect(records).toHaveLength(1);
    // The distinction this whole change exists for: unknown must stay unknown. A `false`
    // here would publish a drop-in claim about a yoga course.
    expect(records[0].registrationRequired).toBeUndefined();
    expect(records[0]).not.toHaveProperty('registrationRequired', false);
    expect(stats.registrationUnknown).toBe(1);
    expect(stats.registrationDropIn).toBe(0);
  });

  it('fails closed when bookingType is absent from the fetched calendar', () => {
    const { records, stats } = parseTenantCalendars(nvrc, [calendar({ bookingType: undefined })], { window: WINDOW });
    expect(records[0].registrationRequired).toBeUndefined();
    expect(stats.registrationUnknown).toBe(1);
  });
});

describe('perfectmind — the per-record REGISTER override', () => {
  it('lets a REGISTER button overrule its own calendar', () => {
    const mixed = calendar({
      classes: [classRecord(), classRecord({ EventId: 'evt-2', EventName: 'Badminton Court 2', BookButtonText: 'REGISTER' })],
      occurrenceCount: 2,
    });
    const { records, stats } = parseTenantCalendars(nvrc, [mixed], { window: WINDOW });
    expect(records).toHaveLength(2);
    expect(records[0].registrationRequired).toBe(false);
    // The calendar says drop-in; this record's own vendor CTA says otherwise and wins.
    expect(records[1].registrationRequired).toBe(true);
    expect(stats.registrationDropIn).toBe(1);
    expect(stats.registrationRequired).toBe(1);
  });

  it('reads REGISTER case-insensitively and ignores the ordinary More Info button', () => {
    expect(recordAssertsRegistration(classRecord({ BookButtonText: 'REGISTER' }))).toBe(true);
    expect(recordAssertsRegistration(classRecord({ BookButtonText: 'Register Now' }))).toBe(true);
    expect(recordAssertsRegistration(classRecord({ BookButtonText: 'More Info' }))).toBe(false);
    expect(recordAssertsRegistration(classRecord({ BookButtonText: null }))).toBe(false);
    expect(recordAssertsRegistration(classRecord({ BookButtonText: undefined }))).toBe(false);
  });

  it('does NOT treat "waitlist" wording as a registration signal — the measured counter-example', () => {
    // This is the exact string on a genuine $3 Open Gym record in the committed NVRC
    // drop-in fixture. Reading BookButtonDescription for "waitlist" would have flipped a
    // real drop-in into registration content and taken it out of the default view.
    const openGymWithWaitlistCopy = classRecord({
      BookButtonText: 'More Info',
      BookButtonDescription: 'Add to $3 Open Gym 8yrs+ JBCC Friday 6:15-9:15am waitlist',
      Spots: '',
    });
    expect(recordAssertsRegistration(openGymWithWaitlistCopy)).toBe(false);
    expect(resolveRegistrationRequired(nvrc, { categoryName: DROP_IN_CATEGORY, bookingType: CLASSES_BOOKING_TYPE }, openGymWithWaitlistCopy)).toBe(false);
  });

  it('precedence: REGISTER beats the calendar, the calendar beats silence, silence stays unknown', () => {
    const dropIn = { categoryName: DROP_IN_CATEGORY, bookingType: CLASSES_BOOKING_TYPE };
    const unknown = { categoryName: 'Sports: Badminton', bookingType: CLASSES_BOOKING_TYPE };
    expect(resolveRegistrationRequired(nvrc, dropIn, classRecord({ BookButtonText: 'REGISTER' }))).toBe(true);
    expect(resolveRegistrationRequired(nvrc, dropIn, classRecord())).toBe(false);
    expect(resolveRegistrationRequired(nvrc, unknown, classRecord({ BookButtonText: 'REGISTER' }))).toBe(true);
    expect(resolveRegistrationRequired(nvrc, unknown, classRecord())).toBeUndefined();
  });
});

describe('perfectmind — against the REAL committed vendor payloads', () => {
  function loadClasses(file: string): BookMe4Class[] {
    const raw = JSON.parse(readFileSync(join(__dirname, '../../worker/adapters/perfectmind/__fixtures__', file), 'utf8'));
    return (raw.classes ?? raw) as BookMe4Class[];
  }

  it('calls every record on NVRC\'s captured drop-in calendar drop-in, and none of them registration', () => {
    const classes = [...loadClasses('nvrc.classes.open-gym.page1.json'), ...loadClasses('nvrc.classes.open-gym.page2.json')];
    expect(classes.length).toBe(18);

    const verdicts = classes.map((c) =>
      resolveRegistrationRequired(nvrc, { categoryName: DROP_IN_CATEGORY, bookingType: CLASSES_BOOKING_TYPE }, c)
    );
    // 18/18 false. Several of these carry "Add to ... waitlist" in BookButtonDescription and
    // one carries `Spots: "28 spots left"` — neither is allowed to make them registration.
    expect(verdicts.every((v) => v === false)).toBe(true);
  });

  it('flags the REGISTER records in Richmond\'s captured REGISTERED calendar', () => {
    // Richmond has no PerfectMind drop-in widget (G-T8-1), so this calendar is never
    // ingested — it is here as the contrast case that proves the override reads real vendor
    // data and not just a synthetic string.
    const classes = loadClasses('richmond.classes.registered-visits.json');
    const registerButtons = classes.filter((c) => recordAssertsRegistration(c));
    expect(registerButtons.length).toBe(2);
    expect(classes.length - registerButtons.length).toBe(3);

    // On a calendar we cannot place as drop-in, the three non-REGISTER records stay UNKNOWN
    // rather than being called drop-in by omission.
    const unplaceable = { categoryName: 'Registered Visits', bookingType: CLASSES_BOOKING_TYPE };
    const verdicts = classes.map((c) => resolveRegistrationRequired(nvrc, unplaceable, c));
    expect(verdicts.filter((v) => v === true)).toHaveLength(2);
    expect(verdicts.filter((v) => v === undefined)).toHaveLength(3);
    expect(verdicts.filter((v) => v === false)).toHaveLength(0);
  });
});
