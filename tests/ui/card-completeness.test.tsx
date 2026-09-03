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
  REGISTRATION_REQUIRED_TAG,
  bookingTag,
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
    // INVERTED 2026-09-03: the CategoryTile was removed catalogue-wide (Jon). It was decorative
    // and the category is still stated in text, so no fact left the card — this now guards the
    // removal (including the 72px grid column the glyph used to occupy) rather than its presence.
    expect(html).not.toContain('kf-tile');
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

  it('handles unknown cost honestly (G-T22-3 / T-10): "Price not confirmed — check source", never "Free"', () => {
    const html = renderToStaticMarkup(
      <ActivityCard activity={activity({ costStatus: 'unknown', costMinCad: null, costMaxCad: null })} />,
    );
    expect(html).toContain('Price not confirmed — check source');
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

// ─────────────────────────────────────────────────────────────────────────────
// The card states its status ONCE (Jon's beta feedback on the freshness stamp).
//
// "Bookable now" is the only exact string shared by the two independent vocabularies the
// card renders — the BOOKING read (`activity.booking` → bookingTag(), the pill) and the
// STATUS read (`activity.status` → statusMeta(), the freshness stamp) — and search-api's
// mapBooking sends every `bookable_open` occurrence to `bookable_now`, so it collided on
// every such card. The pill keeps it; the stamp drops it and is left as source credit +
// freshness.
//
// THE POINT OF THESE TESTS IS THE CONDITION, NOT THE DELETION. Deleting the stamp's label
// outright would have stripped the ONLY status text from every card whose status the pill
// cannot state — 'May be stale', 'Unverified', 'Full', 'Out of season', 'Suspended' — and
// breached the honesty invariant (UXR-06 / T-07) the statusMeta header states. The second
// test below fails on exactly that mistake.
// ─────────────────────────────────────────────────────────────────────────────
describe('status is stated once on the card face (freshness-stamp de-duplication)', () => {
  /** The freshness stamp's own markup, sliced out of the rendered card. */
  function stampOf(html: string): string {
    const start = html.indexOf('<span class="kf-stamp');
    const end = html.indexOf('<span class="kf-card__cta"', start);
    expect(start, 'card renders a freshness stamp').toBeGreaterThan(-1);
    expect(end, 'the stamp precedes the CTA').toBeGreaterThan(start);
    return html.slice(start, end);
  }

  /** Visible text only — tags (and therefore aria-label attributes) stripped. */
  const visibleText = (html: string) => html.replace(/<[^>]*>/g, ' ');
  const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  it('a bookable_open card prints "Bookable now" once — in the pill, not in the stamp', () => {
    const a = activity({ statusState: 'bookable_open' });
    // Precondition: this really is the colliding case, or the test proves nothing.
    expect(bookingTag(a.booking)).toBe(statusMeta(a.status).label);

    const html = renderToStaticMarkup(<ActivityCard activity={a} />);
    const stamp = stampOf(html);

    // Once VISIBLY. It also appears in the aria-label, which is the parity that is wanted:
    // one visible statement, one announced statement (tags are stripped before counting).
    expect(occurrences(visibleText(html), 'Bookable now'), 'stated exactly once on the face').toBe(1);
    expect(occurrences(html, 'Bookable now'), 'once visible + once announced').toBe(2);
    expect(html, 'the pill keeps it').toContain('<span class="kf-tag kf-tag--book">Bookable now</span>');
    expect(stamp, 'the stamp drops it').not.toContain('Bookable now');
    // What Jon asked to keep inside the dashed box.
    expect(stamp, 'source credit stays').toContain(a.sourceName);
    expect(stamp, 'freshness stays').toContain(formatChecked(a.lastCheckedIso));
    // The aria-label announces the label that is still VISIBLE (in the pill) — no drift.
    expect(html).toContain(`aria-label="${[
      `${a.activityName} at ${a.venue}`,
      `${formatWhen(a.startIso, a.endIso).day} ${formatWhen(a.startIso, a.endIso).time}`,
      formatAges(a.ageMin, a.ageMax),
      'Bookable now',
    ].join(', ')}"`);
  });

  // THE QUADRANT THE ALL-16 TEST BELOW CANNOT SEE — and the one where an equality check and a
  // `status === 'bookable_open'` special case disagree.
  //
  // That test drives booking through mapBooking with `bookingUrl: null` and no drop_in tag, so
  // for 15 of the 16 statuses the pill is EMPTY and for the 16th it COLLIDES. It never renders a
  // card whose pill is non-empty AND non-colliding, which is exactly the shape a special case
  // gets wrong. This case supplies it, and it is ordinary production data, not a contrivance:
  // isRegistrationShaped (lib/search/filters/registration.ts) keys on the title, entirely
  // independently of status, so a registration-shaped title on a bookable_open occurrence gives a
  // "Registration required" pill beside a "Bookable now" status. Nothing is duplicated, so the
  // stamp must keep its label — otherwise this card states no status at all.
  it('keeps the stamp label when the pill is non-empty but states something DIFFERENT', () => {
    const a = activity({ statusState: 'bookable_open', activityName: 'Swim Lessons Level 3' });
    const label = statusMeta(a.status).label;

    // Preconditions — assert the fixture really is this quadrant, or the test proves nothing.
    expect(a.registrationRequired, 'registration-shaped by title alone').toBe(true);
    expect(a.booking, 'still bookable_open → bookable_now').toBe('bookable_now');
    expect(REGISTRATION_REQUIRED_TAG, 'pill is non-empty').not.toBe('');
    expect(REGISTRATION_REQUIRED_TAG, 'and does NOT collide with the status label').not.toBe(label);

    const html = renderToStaticMarkup(<ActivityCard activity={a} />);
    expect(html, 'the pill states registration').toContain(REGISTRATION_REQUIRED_TAG);
    expect(stampOf(html), 'the stamp is the only place this status is stated').toContain(label);
  });

  it('the stamp still carries the status text for every status the pill cannot state', () => {
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
      const label = statusMeta(status).label;
      const pill = a.registrationRequired ? REGISTRATION_REQUIRED_TAG : bookingTag(a.booking);
      const stamp = stampOf(renderToStaticMarkup(<ActivityCard activity={a} />));
      if (pill === label) {
        expect(stamp, `${status}: stamp yields to the identical pill`).not.toContain(label);
      } else {
        // No pill states this status, so the stamp is the only status text on the card.
        expect(stamp, `${status}: stamp is the only status text and must keep it`).toContain(label);
      }
    }
  });
});
