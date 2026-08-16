import { describe, it, expect } from 'vitest';
import {
  AGE_NOT_STATED,
  ageGuide,
  bookingTag,
  confidenceMeta,
  daysSince,
  formatAges,
  formatChecked,
  formatCost,
  formatDistance,
  formatDistanceValue,
  formatOpenHoursWindow,
  formatWhen,
  practicalFacts,
  statusMeta,
} from '../app/preview/_data/format';
import { mapSearchItemToActivity, searchApiUrl, type ListingRecordDto } from '../app/preview/_data/search-api';
import type { StatusState } from '../app/preview/_data/types';

describe('formatAges', () => {
  it('formats a normal band', () => {
    expect(formatAges(5, 9)).toBe('Ages 5–9');
  });
  it('collapses equal bounds', () => {
    expect(formatAges(4, 4)).toBe('Age 4');
  });
  it('renders an open-at-zero band as "Under n"', () => {
    expect(formatAges(0, 5)).toBe('Under 6');
  });
  it('renders wide bands as "All ages" or "Ages n+"', () => {
    expect(formatAges(0, 99)).toBe('All ages');
    expect(formatAges(16, 99)).toBe('Ages 16+');
  });

  // P0 — absent data must render as absent, never as a permissive default. A missing age used
  // to arrive here as an invented (0, 18) and print "All ages"; 41 of 100 listings sampled from
  // the live API on 2026-08-16 held null bounds and every one of them said so to parents.
  it('says the source stated nothing, rather than claiming "All ages"', () => {
    expect(formatAges(null, null)).toBe(AGE_NOT_STATED);
    expect(formatAges(null, null)).not.toBe('All ages');
  });

  it('still says "All ages" when the source genuinely did — open-ended is not unknown', () => {
    // (0, null) is a source that stated a floor of zero and no ceiling: a real all-ages claim.
    // Only BOTH bounds missing means unknown, which is what keeps the legitimate case working.
    expect(formatAges(0, null)).toBe('All ages');
    expect(formatAges(5, null)).toBe('Ages 5+');
  });
});

describe('ageGuide', () => {
  it('names a single-band range and calls it one age group', () => {
    const g = ageGuide(2, 4);
    expect(g.range).toBe('Ages 2–4');
    expect(g.band).toBe('Toddlers');
    expect(g.siblingFit).toContain('one age group');
    expect(g.unspecified).toBe(false);
  });
  it('joins first and last band across a wide range and reads sibling-friendly', () => {
    const g = ageGuide(0, 12);
    expect(g.band).toBe('Babies to tweens');
    expect(g.siblingFit).toContain('siblings of different ages');
  });
  it('flags an unspecified (fully open) range without overclaiming', () => {
    const g = ageGuide(0, 18);
    expect(g.unspecified).toBe(true);
    expect(g.siblingFit).toContain("doesn't list an age limit");
  });
  it('reads a two-band span as close-in-age siblings', () => {
    const g = ageGuide(5, 12); // school-age kids + tweens
    expect(g.band).toBe('School-age kids to tweens');
    expect(g.siblingFit).toContain('two age groups');
  });
  it('offers no band and no sibling read when the source stated no age', () => {
    // The old (0, 18) fallback reached this function and answered "Babies to teens · Wide age
    // range — one outing that can work for siblings of different ages" about a listing whose
    // source never mentioned age at all.
    const g = ageGuide(null, null);
    expect(g.range).toBe(AGE_NOT_STATED);
    expect(g.band).toBe('Not stated');
    expect(g.band).not.toContain('Babies');
    expect(g.siblingFit).toContain("doesn't state who this is for");
    expect(g.unspecified).toBe(true);
  });
});

describe('practicalFacts', () => {
  it('always states indoor vs outdoor and adds only true qualities', () => {
    expect(practicalFacts({ indoor: true, rainyDay: true, dropIn: true })).toEqual([
      'Indoor',
      'Rainy-day friendly',
      'No registration needed',
    ]);
  });
  it('drops qualities that are not true and reads outdoor when not indoor', () => {
    expect(practicalFacts({ indoor: false, rainyDay: false, dropIn: false })).toEqual(['Outdoor']);
  });
});

describe('formatCost', () => {
  it('shows Free for free', () => {
    expect(formatCost({ costStatus: 'free' })).toBe('Free');
  });
  it('shows a single price', () => {
    expect(formatCost({ costStatus: 'known', costMinCad: 7 })).toBe('$7 approx.');
  });
  it('shows a range', () => {
    expect(formatCost({ costStatus: 'known', costMinCad: 3, costMaxCad: 4 })).toBe('$3–$4');
  });
  it('never presents unknown cost as free', () => {
    expect(formatCost({ costStatus: 'unknown' })).toBe('Cost — check source');
  });
});

describe('formatDistance', () => {
  it('renders area, drive time and km', () => {
    expect(formatDistance({ area: 'Trout Lake', driveMinutes: 12, distanceKm: 4.1 })).toBe(
      'Trout Lake · 12 min drive · 4.1 km',
    );
  });

  it('states that the distance is unavailable rather than printing a number, when none was measured', () => {
    expect(formatDistance({ area: 'Steveston', driveMinutes: null, distanceKm: null })).toBe(
      'Steveston · Distance unavailable',
    );
  });

  it('never renders "0.0 km" or a drive time for an unmeasured distance', () => {
    const line = formatDistance({ area: 'Metro Vancouver', driveMinutes: null, distanceKm: null });
    expect(line).not.toContain('km');
    expect(line).not.toContain('drive');
    expect(line).not.toContain('0.0');
  });

  it('keeps the area in BOTH readings, so the meta line never collapses', () => {
    expect(formatDistance({ area: 'Trout Lake', driveMinutes: null, distanceKm: null })).toContain('Trout Lake');
  });
});

describe('formatDistanceValue (detail stat row)', () => {
  it('renders the measured distance', () => {
    expect(formatDistanceValue({ distanceKm: 4.14 })).toBe('4.1 km');
  });
  it('reads "Unavailable" under its own Distance label rather than a fabricated 0.0 km', () => {
    expect(formatDistanceValue({ distanceKm: null })).toBe('Unavailable');
  });
});

describe('freshness math', () => {
  const now = '2026-07-13T09:00:00-07:00';
  it('counts whole days since last check', () => {
    expect(daysSince('2026-07-07T09:00:00-07:00', now)).toBe(6);
    expect(daysSince('2026-07-13T06:00:00-07:00', now)).toBe(0);
  });
  it('produces friendly checked copy', () => {
    expect(formatChecked('2026-07-13T06:00:00-07:00', now)).toBe('Checked today');
    expect(formatChecked('2026-07-12T06:00:00-07:00', now)).toBe('Checked yesterday');
    expect(formatChecked('2026-07-07T06:00:00-07:00', now)).toBe('Checked 6 days ago');
  });
});

describe('formatWhen (America/Vancouver)', () => {
  it('formats a whole-hour afternoon range tightly', () => {
    const when = formatWhen('2026-07-18T14:00:00-07:00', '2026-07-18T16:00:00-07:00');
    expect(when.day).toContain('Jul');
    expect(when.day).toContain('18');
    expect(when.day.startsWith('Sat')).toBe(true);
    expect(when.time).toBe('2 PM–4 PM');
  });
  it('keeps minutes when not on the hour', () => {
    const when = formatWhen('2026-07-19T10:00:00-07:00', '2026-07-19T11:30:00-07:00');
    expect(when.time).toBe('10 AM–11:30 AM');
  });

  // ── Multi-day spans ─────────────────────────────────────────────────────────────────────────
  // The defect the first effectiveness measurement caught. Richmond Public Library publishes its
  // summer programmes as ONE occurrence spanning weeks; taking the day from `start` and the clock
  // from both ends printed "Wed, Jul 8 · 12 AM–11:59 PM" for a programme running until 2 September.
  // On 16 August a parent read a one-day event that had finished five weeks earlier — stamped
  // "Confirmed · Checked today". The row was never expired; this line was.

  it('prints a multi-day programme as the span it is, not as its first day', () => {
    // Summer Scavenger Hunt, verbatim from live production on 2026-08-16.
    const when = formatWhen('2026-07-08T07:00:00.000Z', '2026-09-03T06:59:59.000Z');
    expect(when.day).toBe('Jul 8 – Sep 2');
    expect(when.time).toBe('All day');
    // The precise regression: no weekday-prefixed single day, and no same-day clock range.
    expect(when.day.startsWith('Wed')).toBe(false);
    expect(when.time).not.toContain('11:59');
  });

  it('refuses to invent per-day times for a multi-day span that is not whole-day', () => {
    const when = formatWhen('2026-08-17T13:00:00-07:00', '2026-08-19T18:30:00-07:00');
    expect(when.day).toBe('Aug 17 – Aug 19');
    expect(when.time).toBe('See listing for times');
  });

  it('treats an occurrence that merely crosses UTC midnight as the single local day it is', () => {
    // 2026-08-17 06:00 → 21:45 Vancouver, stored as two different UTC days. Local days decide.
    const when = formatWhen('2026-08-17T13:00:00.000Z', '2026-08-18T04:45:00.000Z');
    expect(when.day.startsWith('Mon')).toBe(true);
    expect(when.time).toBe('6 AM–9:45 PM');
  });

  it('never lets a backwards or unparseable end widen the span', () => {
    const backwards = formatWhen('2026-08-16T21:00:00.000Z', '2026-06-01T00:00:00.000Z');
    expect(backwards.day.startsWith('Sun')).toBe(true);
    expect(backwards.time).toBe('2 PM–2 PM');
    const unparseable = formatWhen('2026-08-16T21:00:00.000Z', 'not-a-date');
    expect(unparseable.day.startsWith('Sun')).toBe(true);
  });

  // ── Listings with no fixed date ──────────────────────────────────────────────────────────────
  // A standing open-hours record genuinely has no start instant. The when-line must say so and
  // print the venue's published hours instead of a manufactured timestamp.

  it('states a dateless listing as available any day, with the venue\'s published hours', () => {
    const when = formatWhen(null, null, 'Daily 10 AM–5 PM');
    expect(when.day).toBe('Available any day');
    expect(when.time).toBe('Daily 10 AM–5 PM');
  });

  it('says so plainly when a dateless listing has no published hours either', () => {
    const when = formatWhen(null, null);
    expect(when.day).toBe('Available any day');
    expect(when.time).toBe('Check opening hours');
    expect(when.time).not.toMatch(/\d{4}|AM|PM/); // no invented clock, no invented year
  });

  it('never renders a null start as epoch zero (1969-12-31) or as the current moment', () => {
    // Both historical symptoms of the same defect: `new Date(null)` lands on 1969-12-31 in
    // Vancouver, and the mapper's `?? new Date().toISOString()` stand-in rendered the H.R.
    // MacMillan Space Centre's general admission as a zero-length event at page-load time.
    const when = formatWhen(null, null, 'Daily 10 AM–5 PM');
    const line = `${when.day} ${when.time}`;
    expect(line).not.toContain('1969');
    expect(line).not.toContain('Dec 31');
    const nowYear = String(new Date().getFullYear());
    expect(line).not.toContain(nowYear);
  });

  it('falls back to the no-fixed-date shape rather than printing an unparseable start', () => {
    const when = formatWhen('not-a-date', 'not-a-date', 'Daily 10 AM–5 PM');
    expect(when.day).toBe('Available any day');
    expect(when.time).toBe('Daily 10 AM–5 PM');
  });
});

describe('formatOpenHoursWindow', () => {
  it('renders a parsed daily window as a human opening line', () => {
    expect(formatOpenHoursWindow({ startMin: 10 * 60, endMin: 17 * 60 })).toBe('Open 10 AM–5 PM');
    expect(formatOpenHoursWindow({ startMin: 9 * 60 + 30, endMin: 12 * 60 })).toBe('Open 9:30 AM–12 PM');
    expect(formatOpenHoursWindow({ startMin: 0, endMin: 23 * 60 + 59 })).toBe('Open 12 AM–11:59 PM');
  });
});

describe('statusMeta', () => {
  // The 16 canonical BR-12 status_state values (TSD §6.2, Appendix C). Every one MUST
  // resolve to honest, non-empty copy — no live status may fall through to "Unknown".
  const ALL_STATUSES: StatusState[] = [
    'confirmed',
    'bookable_open',
    'not_yet_bookable',
    'schedule_not_published',
    'inferred_recurring',
    'manual_candidate',
    'seasonal_out_of_season',
    'seasonal_preseason',
    'seasonal_active',
    'suspended',
    'stale',
    'cancelled',
    'postponed',
    'full',
    'waitlist',
    'needs_review',
  ];
  const VALID_TONES = new Set(['confirmed', 'info', 'expected', 'cancelled', 'muted']);

  it('covers all 16 canonical states with non-empty label + copy + icon (T25-1)', () => {
    expect(ALL_STATUSES).toHaveLength(16);
    for (const status of ALL_STATUSES) {
      const m = statusMeta(status);
      expect(m.label.trim().length, `${status} label`).toBeGreaterThan(0);
      expect(m.copy.trim().length, `${status} copy`).toBeGreaterThan(0);
      expect(m.icon.trim().length, `${status} icon`).toBeGreaterThan(0);
      expect(VALID_TONES.has(m.tone), `${status} tone`).toBe(true);
      expect(['confirmed', 'expected']).toContain(m.section);
      // No live status is ever labelled the generic pre-fix placeholder.
      expect(m.label).not.toBe('Unknown');
    }
  });

  it('marks ONLY confirmed + bookable_open as the confirmed section (UXR-06 / T-07)', () => {
    const confirmedStates = ALL_STATUSES.filter((s) => statusMeta(s).section === 'confirmed');
    expect(confirmedStates.sort()).toEqual(['bookable_open', 'confirmed']);
  });

  it('routes not-yet-posted / seasonal / stale / cancelled to expected', () => {
    expect(statusMeta('schedule_not_published').section).toBe('expected');
    expect(statusMeta('seasonal_out_of_season').section).toBe('expected');
    expect(statusMeta('stale').section).toBe('expected');
    expect(statusMeta('cancelled').section).toBe('expected');
  });

  it('never overstates availability for full / waitlist (not "opens soon")', () => {
    const full = statusMeta('full');
    expect(full.label.toLowerCase()).toContain('full');
    expect(full.copy.toLowerCase()).toContain('full');
    expect(full.label.toLowerCase()).not.toContain('opens soon');
    const waitlist = statusMeta('waitlist');
    expect(waitlist.label.toLowerCase()).toContain('waitlist');
    expect(waitlist.copy.toLowerCase()).not.toContain('opens soon');
  });

  it('names the seasonal phase honestly (active is not "usually weekly")', () => {
    const active = statusMeta('seasonal_active');
    expect(active.label.toLowerCase()).toContain('season');
    expect(active.copy.toLowerCase()).not.toContain('usually runs weekly');
    const pre = statusMeta('seasonal_preseason', 'in May');
    expect(pre.copy).toContain('in May');
    expect(pre.copy.toLowerCase()).not.toContain('usually runs weekly');
  });

  it('reads suspended and unverified states plainly, not "not posted yet"', () => {
    expect(statusMeta('suspended').label.toLowerCase()).toContain('suspend');
    expect(statusMeta('manual_candidate').label.toLowerCase()).toContain('unverified');
    expect(statusMeta('needs_review').label.toLowerCase()).toContain('unverified');
    expect(statusMeta('suspended').copy.toLowerCase()).not.toContain('not posted yet');
  });

  it('interpolates the season label', () => {
    expect(statusMeta('seasonal_out_of_season', 'December').copy).toContain('December');
  });
  it('always carries a text label and an icon (never colour-only)', () => {
    const m = statusMeta('confirmed');
    expect(m.label.length).toBeGreaterThan(0);
    expect(m.icon.length).toBeGreaterThan(0);
  });
});

describe('bookingTag', () => {
  it('maps booking types to copy', () => {
    expect(bookingTag('bookable_now')).toBe('Bookable now');
    expect(bookingTag('drop_in')).toBe('Drop-in');
    expect(bookingTag('registration')).toBe('Registration');
    expect(bookingTag('none')).toBe('');
  });
});

describe('confidenceMeta', () => {
  it('reads official-authority tiers as "Official source" (Blueprint screen-2)', () => {
    expect(confidenceMeta('confirmed')).toEqual({ label: 'Official source', tone: 'confirmed' });
    expect(confidenceMeta('official')).toEqual({ label: 'Official source', tone: 'confirmed' });
  });
  it('names an editorial aggregator honestly (not "official")', () => {
    const m = confidenceMeta('editorial');
    expect(m.label).toBe('Editorial listing');
    expect(m.tone).toBe('info');
    expect(m.label.toLowerCase()).not.toContain('official');
  });
  it('never dresses an unverified community row up as official', () => {
    const m = confidenceMeta('candidate');
    expect(m.label).toBe('Community-listed');
    expect(m.tone).toBe('neutral');
    expect(m.label.toLowerCase()).not.toContain('official');
  });
  it('always carries a non-empty text label + a valid Badge tone (never colour-only)', () => {
    const VALID_TONES = new Set(['confirmed', 'info', 'neutral']);
    for (const c of ['confirmed', 'official', 'editorial', 'candidate'] as const) {
      const m = confidenceMeta(c);
      expect(m.label.trim().length, `${c} label`).toBeGreaterThan(0);
      expect(VALID_TONES.has(m.tone), `${c} tone`).toBe(true);
    }
  });
});

describe('search API mapping — a dateless listing keeps its null', () => {
  /** The H.R. MacMillan Space Centre general-admission row, as live production returns it. */
  const standingAdmission: ListingRecordDto = {
    id: 'oh-1',
    activityName: 'General Admission',
    primaryCategoryKey: 'museum_venue',
    categoryTags: [],
    venueName: 'H.R. MacMillan Space Centre',
    organisation: 'H.R. MacMillan Space Centre',
    descriptionSnippet: '',
    suitabilityTags: ['indoor'],
    startDatetimeUtc: null,
    endDatetimeUtc: null,
    openHours: true,
    openHoursLabel: 'Daily 10 AM–5 PM',
    costStatus: 'check_source',
    costMinCad: null,
    costMaxCad: null,
    statusState: 'confirmed',
    confidenceLabel: 'official_recent',
    lastCheckedAtUtc: '2026-08-16T01:00:00.000Z',
    ageMinMonths: null,
    ageMaxMonths: null,
    geo: { lat: 49.2765, lng: -123.1447 },
    displayArea: 'Vanier Park',
    neighbourhood: null,
    municipalityId: null,
    sourceUrl: 'https://example.org/admission',
    bookingUrl: null,
    locationUrl: null,
  };

  it('never substitutes a manufactured start/end for a listing that has none', () => {
    // This mapping used to read `l.startDatetimeUtc ?? new Date().toISOString()`, because
    // `Activity.startIso` was non-nullable. The type forced the lie: the Space Centre's standing
    // admission rendered as a zero-length event at whatever moment the page was requested, and
    // the same null read through a bare `new Date()` elsewhere came out as 1969-12-31.
    const activity = mapSearchItemToActivity({ distanceKm: 1, listing: standingAdmission });

    expect(activity.startIso).toBeNull();
    expect(activity.endIso).toBeNull();
    expect(activity.timeOfDay).toBeNull();
    expect(activity.openHoursLabel).toBe('Daily 10 AM–5 PM');
  });

  it('derives the hours label from a parsed window when the source text is absent', () => {
    const activity = mapSearchItemToActivity({
      distanceKm: 1,
      listing: { ...standingAdmission, openHoursLabel: null, openHoursLocal: { startMin: 600, endMin: 1020 } },
    });

    expect(activity.startIso).toBeNull();
    expect(activity.openHoursLabel).toBe('Open 10 AM–5 PM');
  });

  it('leaves a dated occurrence untouched, both edges of its span carried verbatim', () => {
    const activity = mapSearchItemToActivity({
      distanceKm: 1,
      listing: {
        ...standingAdmission,
        id: 'rmd-scavenger-hunt',
        openHours: false,
        openHoursLabel: null,
        startDatetimeUtc: '2026-07-08T07:00:00.000Z',
        endDatetimeUtc: '2026-09-03T06:59:59.000Z',
      },
    });

    expect(activity.startIso).toBe('2026-07-08T07:00:00.000Z');
    expect(activity.endIso).toBe('2026-09-03T06:59:59.000Z');
    expect(activity.openHoursLabel).toBeUndefined();
  });
});

describe('search API mapping', () => {
  it('defaults the preview shell to browse approved API rows', () => {
    const url = new URL(searchApiUrl(), 'https://example.test');
    expect(url.searchParams.get('q')).toBe('');
    expect(url.searchParams.get('limit')).toBe('100');
  });

  it('keeps live API cards on the internal detail path and preserves official source links', () => {
    const activity = mapSearchItemToActivity({
      distanceKm: null,
      listing: {
        id: 'live-1',
        activityName: 'Family Storytime',
        primaryCategoryKey: 'storytime',
        categoryTags: ['storytime'],
        venueName: 'Steveston Library (Easthope Hub)',
        organisation: 'Richmond Public Library',
        descriptionSnippet: 'Stories and songs.',
        suitabilityTags: ['indoor'],
        startDatetimeUtc: '2026-09-24T18:00:00.000Z',
        endDatetimeUtc: '2026-09-24T18:30:00.000Z',
        costStatus: 'free',
        costMinCad: null,
        costMaxCad: null,
        statusState: 'confirmed',
        confidenceLabel: 'official_recent',
        lastCheckedAtUtc: '2026-07-13T20:00:00.000Z',
        ageMinMonths: null,
        ageMaxMonths: null,
        geo: { lat: 49.12546, lng: -123.1783832 },
        displayArea: 'Steveston',
        neighbourhood: null,
        municipalityId: 'Richmond',
        sourceUrl: 'https://yourlibrary.bibliocommons.com/v2/events/live-1',
        bookingUrl: null,
        locationUrl: 'https://www.google.com/maps/search/?api=1&query=4320%20Moncton',
      },
    });

    expect(activity.detailUrl).toBeUndefined();
    expect(activity.sourceUrl).toBe('https://yourlibrary.bibliocommons.com/v2/events/live-1');
    expect(activity.area).toBe('Steveston');
    // This used to assert `> 10` — the haversine from a hardcoded East Vancouver point to this
    // Richmond venue. It was asserting the FABRICATION: the API said null (no origin), and the
    // mapper invented a confident number anyway. A venue's own coordinates are not a distance;
    // a distance needs an origin the parent gave us, and this request had none.
    expect(activity.distanceKm).toBeNull();
    expect(activity.driveMinutes).toBeNull();
    expect(activity.ageNotes).toBeUndefined(); // absent when the source has none

    // P0 — null months must reach the card as null, not as the invented 0/18 that made every
    // age-less listing read "All ages". This is the DTO boundary where that claim was minted.
    expect(activity.ageMin).toBeNull();
    expect(activity.ageMax).toBeNull();
    expect(formatAges(activity.ageMin, activity.ageMax)).toBe(AGE_NOT_STATED);
  });

  it('surfaces source-authored age_notes verbatim when present', () => {
    const activity = mapSearchItemToActivity({
      distanceKm: 2,
      listing: {
        id: 'live-2',
        activityName: 'Family Swim',
        primaryCategoryKey: 'public_swim',
        categoryTags: ['public_swim'],
        venueName: 'Templeton Pool',
        organisation: 'City of Vancouver',
        descriptionSnippet: 'Warm shallow end.',
        suitabilityTags: ['indoor'],
        startDatetimeUtc: '2026-07-19T17:00:00.000Z',
        endDatetimeUtc: '2026-07-19T18:30:00.000Z',
        costStatus: 'known',
        costMinCad: 3,
        costMaxCad: 4,
        statusState: 'bookable_open',
        confidenceLabel: 'official',
        lastCheckedAtUtc: '2026-07-13T20:00:00.000Z',
        ageMinMonths: 0,
        ageMaxMonths: 144,
        ageNotes: 'Children under 6 must stay within arm’s reach of an adult.',
        geo: { lat: 49.28, lng: -123.07 },
        displayArea: 'Hastings-Sunrise',
        neighbourhood: 'Hastings-Sunrise',
        municipalityId: 'Vancouver',
        sourceUrl: 'https://vancouver.ca/templeton',
        bookingUrl: null,
        locationUrl: null,
      },
    });

    expect(activity.ageNotes).toBe('Children under 6 must stay within arm’s reach of an adult.');
  });

  // Minimal listing DTO factory — only the fields the status/booking mapping reads matter.
  function listingWith(statusState: string, bookingUrl: string | null = null): ListingRecordDto {
    return {
      id: `s-${statusState}`,
      activityName: 'Public Swim',
      primaryCategoryKey: 'public_swim',
      categoryTags: ['public_swim'],
      venueName: 'Kitsilano Pool',
      organisation: 'City of Vancouver',
      descriptionSnippet: '',
      suitabilityTags: [],
      startDatetimeUtc: '2026-07-20T17:00:00.000Z',
      endDatetimeUtc: '2026-07-20T18:00:00.000Z',
      costStatus: 'free',
      costMinCad: null,
      costMaxCad: null,
      statusState,
      confidenceLabel: 'official',
      lastCheckedAtUtc: '2026-07-13T20:00:00.000Z',
      ageMinMonths: 0,
      ageMaxMonths: 144,
      geo: { lat: 49.27, lng: -123.15 },
      displayArea: 'Kitsilano',
      neighbourhood: 'Kitsilano',
      municipalityId: 'Vancouver',
      sourceUrl: 'https://vancouver.ca/kits',
      bookingUrl,
      locationUrl: null,
    };
  }

  it('passes every canonical status through verbatim — no collapsing (T25)', () => {
    const canonical: StatusState[] = [
      'confirmed',
      'bookable_open',
      'not_yet_bookable',
      'schedule_not_published',
      'inferred_recurring',
      'manual_candidate',
      'seasonal_out_of_season',
      'seasonal_preseason',
      'seasonal_active',
      'suspended',
      'stale',
      'cancelled',
      'postponed',
      'full',
      'waitlist',
      'needs_review',
    ];
    for (const status of canonical) {
      const activity = mapSearchItemToActivity({ distanceKm: 1, listing: listingWith(status) });
      expect(activity.status, status).toBe(status);
    }
  });

  it('no longer disguises full/waitlist/seasonal_active as other states', () => {
    expect(mapSearchItemToActivity({ distanceKm: 1, listing: listingWith('full') }).status).toBe('full');
    expect(mapSearchItemToActivity({ distanceKm: 1, listing: listingWith('waitlist') }).status).toBe('waitlist');
    expect(mapSearchItemToActivity({ distanceKm: 1, listing: listingWith('seasonal_active') }).status).toBe(
      'seasonal_active',
    );
  });

  it('degrades an unexpected status string to needs_review, never a confirmed-looking state', () => {
    const activity = mapSearchItemToActivity({ distanceKm: 1, listing: listingWith('totally_unknown_state') });
    expect(activity.status).toBe('needs_review');
  });

  it('suppresses the book/register chip for genuinely non-bookable statuses', () => {
    // A full class with a booking URL must NOT advertise "Registration" on the card.
    expect(mapSearchItemToActivity({ distanceKm: 1, listing: listingWith('full', 'https://book.example') }).booking).toBe(
      'none',
    );
    expect(
      mapSearchItemToActivity({ distanceKm: 1, listing: listingWith('waitlist', 'https://book.example') }).booking,
    ).toBe('none');
    expect(
      mapSearchItemToActivity({ distanceKm: 1, listing: listingWith('suspended', 'https://book.example') }).booking,
    ).toBe('none');
    // Bookable-open and a confirmed registration still present their affordance.
    expect(mapSearchItemToActivity({ distanceKm: 1, listing: listingWith('bookable_open') }).booking).toBe('bookable_now');
    expect(
      mapSearchItemToActivity({ distanceKm: 1, listing: listingWith('confirmed', 'https://book.example') }).booking,
    ).toBe('registration');
  });

  // ── Distance honesty (P0) ──────────────────────────────────────────────────
  // The engine returns `distanceKm: null` whenever there is no origin to measure from — no
  // near-me coordinates, no saved location — which is the DEFAULT for an anonymous search.
  // The mapper used to fill that null in from a hardcoded East Vancouver point, so every card
  // stated a confident distance from a place the parent never gave us.

  it('carries a REAL measured distance through unchanged, with a drive time derived from it', () => {
    const activity = mapSearchItemToActivity({ distanceKm: 3.2, listing: listingWith('confirmed') });
    expect(activity.distanceKm).toBe(3.2);
    expect(activity.driveMinutes).toBe(13);
    expect(formatDistance(activity)).toBe('Kitsilano · 13 min drive · 3.2 km');
  });

  it('holds the drive time at the 4-minute floor for a very close listing', () => {
    expect(mapSearchItemToActivity({ distanceKm: 0.2, listing: listingWith('confirmed') }).driveMinutes).toBe(4);
  });

  it('reports NO distance when the search had no origin, even though the venue is geocoded', () => {
    const listing = listingWith('confirmed');
    expect(listing.geo).not.toBeNull(); // the venue's own coordinates are not a distance
    const activity = mapSearchItemToActivity({ distanceKm: null, listing });
    expect(activity.distanceKm).toBeNull();
    expect(activity.driveMinutes).toBeNull();
    expect(formatDistance(activity)).toBe('Kitsilano · Distance unavailable');
  });

  it('reports NO distance — not 0 km — for an un-geocoded venue', () => {
    const activity = mapSearchItemToActivity({
      distanceKm: null,
      listing: { ...listingWith('confirmed'), geo: null },
    });
    expect(activity.distanceKm).toBeNull();
    expect(activity.distanceKm).not.toBe(0);
    expect(activity.driveMinutes).toBeNull();
    expect(formatDistance(activity)).not.toContain('0.0 km');
  });

  it('does not vary an unmeasured distance by venue location — there is nothing to vary', () => {
    // The old fabrication produced a DIFFERENT invented number per venue, which is exactly what
    // made it read as real. Two venues 20 km apart, same missing origin, same honest answer.
    const near = mapSearchItemToActivity({ distanceKm: null, listing: listingWith('confirmed') });
    const far = mapSearchItemToActivity({
      distanceKm: null,
      listing: { ...listingWith('confirmed'), geo: { lat: 49.05, lng: -122.32 } }, // Abbotsford
    });
    expect(near.distanceKm).toBeNull();
    expect(far.distanceKm).toBeNull();
  });
});
