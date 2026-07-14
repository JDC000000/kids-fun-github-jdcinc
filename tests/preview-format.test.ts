import { describe, it, expect } from 'vitest';
import {
  ageGuide,
  bookingTag,
  daysSince,
  formatAges,
  formatChecked,
  formatCost,
  formatDistance,
  formatWhen,
  practicalFacts,
  statusMeta,
} from '../app/preview/_data/format';
import { mapSearchItemToActivity, searchApiUrl } from '../app/preview/_data/search-api';

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
  it('routes confirmed + bookable to the confirmed section', () => {
    expect(statusMeta('confirmed').section).toBe('confirmed');
    expect(statusMeta('bookable_open').section).toBe('confirmed');
  });
  it('routes not-yet-posted / seasonal / stale / cancelled to expected', () => {
    expect(statusMeta('schedule_not_published').section).toBe('expected');
    expect(statusMeta('seasonal_out_of_season').section).toBe('expected');
    expect(statusMeta('stale').section).toBe('expected');
    expect(statusMeta('cancelled').section).toBe('expected');
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
});
