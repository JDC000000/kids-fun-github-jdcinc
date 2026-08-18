import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { FreshnessStamp } from '../../app/preview/_components/FreshnessStamp';
import { CHECK_NOT_RECORDED, FIXTURE_NOW, formatChecked } from '../../app/preview/_data/format';
import { mapSearchItemToActivity, type ListingRecordDto } from '../../app/preview/_data/search-api';
import type { Activity } from '../../app/preview/_data/types';

// P0-3 — THE FRESHNESS BADGE MUST BE A READING, NOT A DECORATION.
//
// The defect this file pins, in the two places it lived:
//
//   1. `daysSince`/`formatChecked` defaulted `nowIso` to FIXTURE_NOW ('2026-07-13'), a frozen
//      sprint date, and floored the difference at 0. Every live listing has been checked SINCE
//      that date, so every live listing produced a negative difference, was floored to 0, and
//      printed "Checked today" — forever, for every row, whatever its real last check. Measured
//      against the 2026-08-18 snapshot DB (603 live occurrences, last_checked_at 16–17 Aug):
//      603 of 603 rendered "Checked today". Honest, in Vancouver calendar days: 183 ×
//      "yesterday", 420 × "2 days ago" — zero of the 603 had been checked on the day the
//      badge said they had.
//   2. `mapSearchItemToActivity` filled a NULL `lastCheckedAtUtc` with `new Date()`, so a row
//      nothing had ever checked also claimed "Checked today".
//
// Both are affirmative claims about our own diligence, manufactured at a boundary, on the one
// badge the product sells itself on. The tests below are written so that a regression to EITHER
// — a frozen `now`, or a static string — fails loudly, rather than quietly reading "today".

/**
 * An ISO instant sitting at MIDDAY on the Vancouver calendar day N days before today's.
 *
 * Deliberately calendar arithmetic on the local day, not `Date.now() - n * 86_400_000`. The
 * formatter counts Vancouver CALENDAR days, so an absolute-milliseconds offset can land on the
 * wrong side of a day boundary across a DST transition and flake the run — and midday is the
 * furthest any instant can be from both edges of its own day.
 */
function isoDaysAgo(days: number): string {
  const todayVancouver = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const target = new Date(`${todayVancouver}T00:00:00Z`);
  target.setUTCDate(target.getUTCDate() - days);
  return `${target.toISOString().slice(0, 10)}T12:00:00-07:00`;
}

function listing(overrides: Partial<ListingRecordDto> = {}): ListingRecordDto {
  return {
    id: 'occ-fresh',
    activityName: 'Public Swim',
    primaryCategoryKey: 'public_swim',
    venueName: 'Kitsilano Pool',
    organisation: 'City of Vancouver',
    descriptionSnippet: 'Warm shallow end.',
    startDatetimeUtc: '2026-07-18T21:00:00.000Z',
    endDatetimeUtc: '2026-07-18T23:00:00.000Z',
    costStatus: 'free',
    costMinCad: 0,
    costMaxCad: 0,
    statusState: 'confirmed',
    confidenceLabel: 'official_recent',
    lastCheckedAtUtc: isoDaysAgo(0),
    ageMinMonths: 60,
    ageMaxMonths: 120,
    geo: { lat: 49.27, lng: -123.15 },
    displayArea: 'Kitsilano',
    neighbourhood: 'Kitsilano',
    municipalityId: 'Vancouver',
    sourceUrl: 'https://vancouver.ca/pools',
    bookingUrl: null,
    locationUrl: null,
    ...overrides,
  };
}

function activity(overrides: Partial<ListingRecordDto> = {}): Activity {
  return mapSearchItemToActivity({ distanceKm: 4.1, listing: listing(overrides) });
}

/** Just the stamp's visible text, tags stripped — what a parent actually reads. */
function stampText(a: Activity): string {
  return renderToStaticMarkup(<FreshnessStamp activity={a} />).replace(/<[^>]+>/g, '');
}

describe('P0-3: the freshness badge reads the listing\'s own timestamp against the real clock', () => {
  // THE CORE PIN. Two listings, one genuinely checked now and one genuinely checked 9 days ago,
  // rendered through the REAL component with no `now` injected anywhere — which is exactly how
  // /search, the home strip and the detail page render it. A frozen default or a static string
  // makes these two identical; only a live reading tells them apart.
  it('distinguishes a fresh listing from an old one, with no injected clock', () => {
    const fresh = stampText(activity({ id: 'occ-fresh', lastCheckedAtUtc: isoDaysAgo(0) }));
    const old = stampText(activity({ id: 'occ-old', lastCheckedAtUtc: isoDaysAgo(9) }));

    expect(fresh, 'a listing checked today says so').toContain('Checked today');
    expect(old, 'a listing checked 9 days ago says THAT, not "today"').toContain('Checked 9 days ago');
    expect(old, 'the old listing must never claim today').not.toContain('Checked today');
    expect(fresh).not.toBe(old);
  });

  it('walks the whole vocabulary off real timestamps: today / yesterday / N days ago', () => {
    expect(stampText(activity({ lastCheckedAtUtc: isoDaysAgo(0) }))).toContain('Checked today');
    expect(stampText(activity({ lastCheckedAtUtc: isoDaysAgo(1) }))).toContain('Checked yesterday');
    expect(stampText(activity({ lastCheckedAtUtc: isoDaysAgo(2) }))).toContain('Checked 2 days ago');
    expect(stampText(activity({ lastCheckedAtUtc: isoDaysAgo(45) }))).toContain('Checked 45 days ago');
  });

  // THE EXACT DEFECT, FROZEN INTO AN ASSERTION AND FULLY DETERMINISTIC (no reliance on the
  // machine clock). The first line is the precondition that proves this is the real defect
  // shape; the second is the behaviour that replaced it.
  it('no longer measures against the frozen FIXTURE_NOW sprint date', () => {
    const checkedYesterday = '2026-08-17T22:00:00.000Z'; // 1 day before the `now` below
    const realNow = '2026-08-18T14:00:00-07:00';

    expect(
      formatChecked(checkedYesterday, FIXTURE_NOW),
      'precondition: measured against the frozen sprint date this reads "today" — the bug',
    ).toBe('Checked today');
    expect(
      formatChecked(checkedYesterday, realNow),
      'measured against a real now it reads the truth',
    ).toBe('Checked yesterday');
  });

  it('is not a static string: 45 days out reads 45 days, not a capped or bucketed label', () => {
    expect(formatChecked('2026-07-04T12:00:00-07:00', '2026-08-18T12:00:00-07:00')).toBe('Checked 45 days ago');
    expect(formatChecked('2025-08-18T12:00:00-07:00', '2026-08-18T12:00:00-07:00')).toBe('Checked 365 days ago');
  });
});

describe('P0-3: a listing with no check timestamp states the absence', () => {
  it('carries a null lastCheckedAtUtc through the mapper instead of stamping now', () => {
    const a = activity({ lastCheckedAtUtc: null });
    expect(a.lastCheckedIso, 'the mapper must not invent a check that never happened').toBeNull();
  });

  it('renders the honest absence on the stamp, never "Checked today"', () => {
    const text = stampText(activity({ lastCheckedAtUtc: null }));
    expect(text).toContain(CHECK_NOT_RECORDED);
    expect(text).not.toContain('Checked today');
  });

  it('treats an unparseable timestamp as unknown rather than as 0 days ago', () => {
    expect(formatChecked('not-a-date', '2026-08-18T12:00:00-07:00')).toBe(CHECK_NOT_RECORDED);
  });
});
