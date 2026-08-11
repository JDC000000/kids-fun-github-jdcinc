import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// next/link needs no Next runtime for a completeness assertion — render it as the
// plain <a> it becomes on the server, so the test stays a pure markup check (matches
// the node-env approach in components/ui/__tests__/ui.test.tsx).
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: unknown; [k: string]: unknown }) => (
    <a href={typeof href === 'string' ? href : String(href ?? '')} {...rest}>
      {children as never}
    </a>
  ),
}));

import { ActivityCard } from '../../app/preview/_components/ActivityCard';
import {
  confidenceMeta,
  formatAges,
  formatChecked,
  formatCost,
  formatDistance,
  formatWhen,
  statusMeta,
} from '../../app/preview/_data/format';
import { mapSearchItemToActivity, type ListingRecordDto } from '../../app/preview/_data/search-api';
import type { Activity } from '../../app/preview/_data/types';
import type { StatusState } from '../../app/preview/_data/types';

// Card-completeness assertion for T22 exit-AC (G-T22-4, KPI #5): a search ResultCard must
// render 100% of the required parent-facing facts from a single occurrence — what / who /
// when / where / cost / bookability + status + freshness + SOURCE CONFIDENCE + a source CTA
// — never colour-only, never inventing cost. The card is the shared ActivityCard the /search
// list renders (app/search/page.tsx → ActivityCard).

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
    startDatetimeUtc: '2026-07-18T21:00:00.000Z', // Sat 2:00 PM America/Vancouver
    endDatetimeUtc: '2026-07-18T23:00:00.000Z',
    costStatus: 'known',
    costMinCad: 7,
    costMaxCad: null,
    statusState: 'confirmed',
    confidenceLabel: 'official_recent',
    lastCheckedAtUtc: '2026-07-13T16:00:00.000Z',
    ageMinMonths: 60,
    ageMaxMonths: 120, // Ages 5–9
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

function activity(overrides: Partial<ListingRecordDto> = {}): Activity {
  return mapSearchItemToActivity({ distanceKm: 4.1, listing: listing(overrides) });
}

/** Every required card-face fact, computed from the SAME formatters the card uses. */
function requiredFacts(a: Activity): string[] {
  const when = formatWhen(a.startIso, a.endIso);
  return [
    a.activityName, // activity type (what)
    a.venue, // venue / title (where)
    when.day, // date
    when.time, // time
    formatAges(a.ageMin, a.ageMax), // age fit (who)
    formatDistance(a), // area + drive + distance (where)
    formatCost(a), // cost (honest)
    statusMeta(a.status, a.seasonLabel).label, // status (text, never colour-only)
    a.sourceName, // source
    formatChecked(a.lastCheckedIso), // freshness
    // SOURCE CONFIDENCE ("Official source" / "Editorial listing" / "Community-listed") is NO
    // LONGER a required card-face fact. The badge that carried it was removed from the tile on
    // Jon's beta feedback; see ActivityCard.tsx. It is asserted ABSENT below instead, so the
    // removal is pinned rather than merely un-asserted — an un-asserted removal is exactly how
    // a control creeps back.
  ];
}

describe('ResultCard completeness (G-T22-4 / KPI #5)', () => {
  it('renders 100% of the required facts for a confirmed occurrence', () => {
    const a = activity();
    const html = renderToStaticMarkup(<ActivityCard activity={a} />);
    for (const fact of requiredFacts(a)) {
      expect(html, `missing required fact: ${fact}`).toContain(fact);
    }
    // Category illustration tile is present (decorative; category is also in text).
    expect(html).toContain('kf-tile');
    // A keyboard-focusable link is the card (a11y: each card a focusable region).
    expect(html).toMatch(/<a[\s>]/);
    // The source-authority badge is gone from the tile.
    expect(html).not.toContain('Official source');
  });

  it('shows NO source-confidence badge on any tier — the badge was removed from the tile', () => {
    // This replaces the by-tier assertion. The old contract (G-T22-2 / BR-13) was that the
    // card face states WHO VOUCHES for a listing, honestly by tier. That badge is gone.
    //
    // The check runs across all three tiers on purpose: dropping only the 'official' assertion
    // would have left a card that still printed "Community-listed" — the very label the old
    // test existed to keep honest — with nothing asserting the group had gone as a unit.
    //
    // What this does NOT relax: the source is still NAMED on the card (FreshnessStamp), which
    // is the attribution obligation tests/compliance/attribution.test.ts enforces, and that is
    // a separate thing from the authority TIER this badge showed.
    for (const tier of ['official', 'editorial', 'inferred'] as const) {
      const html = renderToStaticMarkup(<ActivityCard activity={activity({ confidenceLabel: tier })} />);
      expect(html, `${tier}: no authority badge`).not.toContain('Official source');
      expect(html, `${tier}: no authority badge`).not.toContain('Editorial listing');
      expect(html, `${tier}: no authority badge`).not.toContain('Community-listed');
      // The source itself is still attributed on the card face, on every tier.
      expect(html, `${tier}: source still named`).toContain(activity().sourceName);
    }
  });

  it('handles unknown cost honestly (G-T22-3 / T-10): "Cost — check source", never "Free"', () => {
    const html = renderToStaticMarkup(
      <ActivityCard activity={activity({ costStatus: 'unknown', costMinCad: null, costMaxCad: null })} />,
    );
    expect(html).toContain('Cost — check source');
    expect(html).not.toContain('Free');
  });

  it('shows an internal "See details" CTA for a live/DB card (stays on the in-app detail path)', () => {
    const html = renderToStaticMarkup(<ActivityCard activity={activity()} />);
    expect(html).toContain('See details');
    expect(html).toContain('/preview/occ-1');
  });

  it('shows a "View on <source>" CTA and opens the official source for an external card', () => {
    const external: Activity = { ...activity(), detailUrl: 'https://vancouver.ca/kits/event' };
    const html = renderToStaticMarkup(<ActivityCard activity={external} />);
    expect(html).toContain('View on vancouver.ca');
    expect(html).toContain('href="https://vancouver.ca/kits/event"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).not.toContain('See details');
  });

  it('keeps every required field present across ALL 16 canonical statuses (no field drops out)', () => {
    const ALL: StatusState[] = [
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
    for (const status of ALL) {
      const a = activity({ statusState: status });
      const html = renderToStaticMarkup(<ActivityCard activity={a} />);
      // Status label (text), confidence, when, age, distance, cost + CTA — all still there.
      expect(html, `${status}: status label`).toContain(statusMeta(status).label);
      expect(html, `${status}: no authority badge`).not.toContain(confidenceMeta(a.confidence).label);
      expect(html, `${status}: source still named`).toContain(a.sourceName);
      expect(html, `${status}: age`).toContain(formatAges(a.ageMin, a.ageMax));
      expect(html, `${status}: distance`).toContain(formatDistance(a));
      expect(html, `${status}: cost`).toContain(formatCost(a));
      expect(html, `${status}: cta`).toMatch(/See details|View on/);
    }
  });
});
