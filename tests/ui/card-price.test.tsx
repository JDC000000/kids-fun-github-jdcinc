import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Same node-env markup approach as tests/ui/card-completeness.test.tsx: next/link is
// rendered as the plain <a> it becomes on the server so this stays a pure markup check.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: unknown; [k: string]: unknown }) => (
    <a href={typeof href === 'string' ? href : String(href ?? '')} {...rest}>
      {children as never}
    </a>
  ),
}));

import { ActivityCard } from '../../app/preview/_components/ActivityCard';
import { mapSearchItemToActivity, type ListingRecordDto } from '../../app/preview/_data/search-api';

// PRICE ON THE CARD FACE (BR-11, TSD §6.2; lib/search/types.ts:15 "unknown/check_source is
// NEVER treated as free").
//
// These render the REAL ActivityCard through the REAL DTO→Activity mapping, not formatCost in
// isolation, because the honesty rule is relational: the card's cost read has to agree with
// what lib/search/filters/cost.ts decides about the SAME listing. A tile saying "$0" for a
// listing that the Free quick filter excludes is a visible contradiction to a parent — they
// see a $0 card, tick "Free", and watch it disappear. Every zero/absent case below exists to
// pin exactly that agreement.

function listing(overrides: Partial<ListingRecordDto> = {}): ListingRecordDto {
  return {
    id: 'occ-price',
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

function cardHtml(overrides: Partial<ListingRecordDto> = {}): string {
  const activity = mapSearchItemToActivity({ distanceKm: 4.1, listing: listing(overrides) });
  return renderToStaticMarkup(<ActivityCard activity={activity} />);
}

/** The card's one honest not-a-number cost read. */
const NOT_A_NUMBER = 'Cost — check source';

describe('ActivityCard price on the face — cost we genuinely have', () => {
  it('renders a single known price', () => {
    const html = cardHtml({ costStatus: 'known', costMinCad: 7, costMaxCad: null });
    expect(html).toContain('$7 approx.');
    expect(html).not.toContain(NOT_A_NUMBER);
  });

  it('renders a known min–max range', () => {
    const html = cardHtml({ costStatus: 'known', costMinCad: 3, costMaxCad: 4 });
    expect(html).toContain('$3–$4');
    expect(html).not.toContain(NOT_A_NUMBER);
  });

  it('collapses an equal min and max to a single price rather than "$12–$12"', () => {
    const html = cardHtml({ costStatus: 'known', costMinCad: 12, costMaxCad: 12 });
    expect(html).toContain('$12 approx.');
    expect(html).not.toContain('$12–$12');
  });

  it('renders a genuinely free listing as free', () => {
    const html = cardHtml({ costStatus: 'free', costMinCad: null, costMaxCad: null });
    expect(html).toContain('Free');
    expect(html).not.toContain(NOT_A_NUMBER);
    expect(html).not.toContain('$');
  });
});

describe('ActivityCard price on the face — cost we do NOT have is never free (BR-11)', () => {
  it('renders unknown cost as not-a-number and not free', () => {
    const html = cardHtml({ costStatus: 'unknown', costMinCad: null, costMaxCad: null });
    expect(html).toContain(NOT_A_NUMBER);
    expect(html).not.toContain('Free');
    expect(html).not.toContain('$');
  });

  it('renders check_source as not-a-number and not free, through the DTO mapping', () => {
    // check_source only reaches the card via mapCost() in search-api.ts — asserting it here
    // rather than on formatCost keeps the mapping inside the honesty guarantee.
    const html = cardHtml({ costStatus: 'check_source', costMinCad: null, costMaxCad: null });
    expect(html).toContain(NOT_A_NUMBER);
    expect(html).not.toContain('Free');
    expect(html).not.toContain('$');
  });

  it('does NOT invent "$0" when the status says known but the source gave no number', () => {
    // A row can be cost_status=known with both bounds null (the DTO and the admin listing form
    // both permit it). Defaulting the missing minimum to 0 printed "$0 approx." — a price we
    // never had, and the one reading a parent is most likely to act on.
    const html = cardHtml({ costStatus: 'known', costMinCad: null, costMaxCad: null });
    expect(html).not.toContain('$0');
    expect(html).not.toContain('Free');
    expect(html).toContain(NOT_A_NUMBER);
  });

  it('does NOT invent a $0 floor when only the maximum is known', () => {
    // min null + max 30 printed "$0–$30", which tells a parent the activity might be free.
    // We know a ceiling, not a floor; state the one number we have.
    const html = cardHtml({ costStatus: 'known', costMinCad: null, costMaxCad: 30 });
    expect(html).not.toContain('$0');
    expect(html).toContain('$30 approx.');
  });

  it('agrees with the Free filter on a known zero: $0/$0 reads as free, not "$0 approx."', () => {
    // isFree() in lib/search/filters/cost.ts calls known+0+0 free, so this listing IS returned
    // under the Free quick filter. The card must say the same word the filter used.
    const html = cardHtml({ costStatus: 'known', costMinCad: 0, costMaxCad: 0 });
    expect(html).toContain('Free');
    expect(html).not.toContain('$0');
  });

  it('agrees with the Free filter on a half-known zero: min 0 with no max is NOT free', () => {
    // isFree() requires costMaxCad === 0, so min 0 + max null is NOT free and the Free filter
    // EXCLUDES it. A "$0" tile for a listing that vanishes the moment a parent ticks Free is
    // the contradiction this case exists to prevent — and a bare "$0" reads as free anyway.
    const html = cardHtml({ costStatus: 'known', costMinCad: 0, costMaxCad: null });
    expect(html).not.toContain('$0');
    expect(html).not.toContain('Free');
    expect(html).toContain(NOT_A_NUMBER);
  });
});
