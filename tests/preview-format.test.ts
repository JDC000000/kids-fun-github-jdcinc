import { describe, it, expect } from 'vitest';
import {
  ageGuide,
  bookingTag,
  confidenceMeta,
  daysSince,
  formatAges,
  formatChecked,
  formatCost,
  formatDistance,
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
    expect(activity.distanceKm).toBeGreaterThan(10);
    expect(activity.ageNotes).toBeUndefined(); // absent when the source has none
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
});
