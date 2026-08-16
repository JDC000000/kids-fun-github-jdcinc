import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Distance honesty on the two rendered surfaces (P0 — fabricated distances).
//
// THE DEFECT THIS FILE PINS: /api/search returns `distanceKm: null` whenever there is no origin
// to measure from — no near-me coordinates, no saved location — which is the DEFAULT state of an
// anonymous search, i.e. what nearly every parent saw. The card/detail mapper filled that null in
// by measuring from a hardcoded East Vancouver coordinate (and by falling back to a flat 0 when
// the venue itself had no geo), and both surfaces then rendered the invented number in the same
// confident typography as a real one: "2.1 km · 9 min drive" from a place the parent never gave
// us. A distance is the single most action-shaping number on the card, so this is asserted at the
// MARKUP level, not just at the formatter — a formatter fixed while a component keeps its own
// inline copy of the string is exactly how this defect survived in ActivityDetail.
//
// The case that must never regress is the last one: a REAL origin still renders a real distance.

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: unknown; [k: string]: unknown }) => (
    <a href={typeof href === 'string' ? href : String(href ?? '')} {...rest}>
      {children as never}
    </a>
  ),
}));

import { ActivityCard } from '../../app/preview/_components/ActivityCard';
import { ActivityDetail } from '../../app/preview/_components/ActivityDetail';
import { mapSearchItemToActivity, type ListingRecordDto } from '../../app/preview/_data/search-api';
import type { Activity } from '../../app/preview/_data/types';

function listing(overrides: Partial<ListingRecordDto> = {}): ListingRecordDto {
  return {
    id: 'occ-1',
    activityName: 'Public Swim',
    primaryCategoryKey: 'public_swim',
    categoryTags: ['public_swim'],
    venueName: 'Kitsilano Pool',
    organisation: 'City of Vancouver',
    descriptionSnippet: 'Warm shallow end.',
    suitabilityTags: ['indoor'],
    startDatetimeUtc: '2026-07-18T21:00:00.000Z',
    endDatetimeUtc: '2026-07-18T23:00:00.000Z',
    costStatus: 'known',
    costMinCad: 7,
    costMaxCad: null,
    statusState: 'confirmed',
    confidenceLabel: 'official_recent',
    lastCheckedAtUtc: '2026-07-13T16:00:00.000Z',
    ageMinMonths: 60,
    ageMaxMonths: 120,
    geo: { lat: 49.27, lng: -123.15 },
    displayArea: 'Kitsilano',
    neighbourhood: 'Kitsilano',
    municipalityId: 'Vancouver',
    sourceUrl: 'https://vancouver.ca/kits',
    bookingUrl: null,
    locationUrl: null,
    ...overrides,
  };
}

const card = (a: Activity) => renderToStaticMarkup(<ActivityCard activity={a} />);
const detail = (a: Activity) =>
  renderToStaticMarkup(<ActivityDetail activity={a} occurrenceId={a.id} backHref="/search" backLabel="Back" />);

/** Any "N.N km" reading, whatever the number — the shape of the claim, not one value of it. */
const KM_READING = /\d+\.\d+\s*km/;
const DRIVE_READING = /\d+\s*min drive/;

describe('no origin — the default anonymous search', () => {
  const noOrigin = mapSearchItemToActivity({ distanceKm: null, listing: listing() });

  it('states "Distance unavailable" on the card instead of a measured-looking number', () => {
    const html = card(noOrigin);
    expect(html).toContain('Distance unavailable');
    expect(html).not.toMatch(KM_READING);
    expect(html).not.toMatch(DRIVE_READING);
  });

  it('keeps the area on the card, so the meta line does not silently disappear', () => {
    expect(card(noOrigin)).toContain('Kitsilano');
  });

  it('states it on the detail hero AND in the stat row — the two places that each had their own copy', () => {
    const html = detail(noOrigin);
    expect(html).toContain('Distance unavailable'); // hero venue line
    expect(html).toContain('Unavailable'); // "Distance" stat, whose label is already the noun
    expect(html).not.toMatch(KM_READING);
    expect(html).not.toMatch(DRIVE_READING);
  });
});

describe('un-geocoded venue', () => {
  const noGeo = mapSearchItemToActivity({ distanceKm: null, listing: listing({ geo: null }) });

  it('never renders the 0.0 km / 4 min drive floor the old fallback produced', () => {
    for (const html of [card(noGeo), detail(noGeo)]) {
      expect(html).not.toContain('0.0 km');
      expect(html).not.toContain('4 min drive');
      expect(html).toContain('Distance unavailable');
    }
  });
});

describe('a real origin — MUST NOT REGRESS', () => {
  // What the engine returns once the parent supplies near-me coordinates or a saved location.
  const measured = mapSearchItemToActivity({ distanceKm: 4.14, listing: listing() });

  it('renders the measured distance and its drive time on the card, exactly as before', () => {
    const html = card(measured);
    expect(html).toContain('Kitsilano · 17 min drive · 4.1 km');
    expect(html).not.toContain('Distance unavailable');
  });

  it('renders it on the detail hero and stat row', () => {
    const html = detail(measured);
    expect(html).toContain('Kitsilano · 17 min drive · 4.1 km');
    expect(html).toContain('4.1 km');
    expect(html).not.toContain('Distance unavailable');
  });
});
