import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

// The hero action cluster (2026-09-10): Maps moved OUT of the sticky action bar and into the
// hero, beside "Call the venue" and the official-source link, and the source link was restyled
// from an underlined text link into a bordered control matching the phone.
//
// Two things in that change can go wrong silently, and this file exists for them:
//
//  1. THE COPY CONTRACT. The button says "Maps". It must never say "Directions". For 99.6% of
//     listings `locationUrl` is a Google Maps text SEARCH built from an address string, not a
//     verified pin — search-api.ts's own note is that "a wrong pin looks authoritative; a search
//     that lands imprecisely visibly is a search". "Directions" promises turn-by-turn to a
//     confirmed point, which the data cannot support. Same spirit as the phone copy contract in
//     venue-phone.test.tsx: asserted, not left to review.
//
//  2. THE BLOCKED-STATE CLAIM. Promoting the source link to button chrome exposed a live defect.
//     A cancelled/postponed session that still carries a bookingUrl rendered "View booking page"
//     in the hero, pointing at a dead booking page, immediately above the bar's own
//     "Cancelled — not available". The hero link has ALWAYS been justified as the SOURCE claim
//     ("here is who says so") — that is the entire reason it survives a blocked status while the
//     bar refuses the action. It never made the source claim in code. It does now.
//
// The "not Directions" and "blocked never books" assertions are the two that must not be
// relaxed; the layout ones below them are ordinary structural guards.

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: unknown; [k: string]: unknown }) => (
    <a href={typeof href === 'string' ? href : String(href ?? '')} {...rest}>{children as never}</a>
  ),
}));

import { ActivityDetail } from '../../app/preview/_components/ActivityDetail';
import { mapSearchItemToActivity, type ListingRecordDto } from '../../app/preview/_data/search-api';
import type { StatusState } from '../../app/preview/_data/types';

const MAPS_URL = 'https://maps.google.com/?q=Kitsilano+Pool';
const SOURCE_URL = 'https://vancouver.ca/kits';
const BOOKING_URL = 'https://book.example.ca/register';

function listing(o: Partial<ListingRecordDto> = {}): ListingRecordDto {
  return {
    id: 'occ-1', activityName: 'Parent & Tot Swim', primaryCategoryKey: 'public_swim',
    categoryTags: ['public_swim'], venueName: 'Kitsilano Pool', organisation: 'City of Vancouver',
    descriptionSnippet: 'Warm shallow end.', suitabilityTags: ['indoor'],
    startDatetimeUtc: '2026-07-18T21:00:00.000Z', endDatetimeUtc: '2026-07-18T23:00:00.000Z',
    costStatus: 'known', costMinCad: 7, costMaxCad: null, statusState: 'confirmed',
    confidenceLabel: 'official_recent', lastCheckedAtUtc: '2026-07-13T16:00:00.000Z',
    ageMinMonths: 60, ageMaxMonths: 120, geo: { lat: 49.27, lng: -123.15 },
    displayArea: 'Kitsilano', neighbourhood: 'Kitsilano', municipalityId: 'Vancouver',
    venuePhone: '(604) 555-0142',
    sourceUrl: SOURCE_URL, bookingUrl: null, locationUrl: MAPS_URL, ...o,
  };
}

const render = (o: Partial<ListingRecordDto> = {}) => {
  const a = mapSearchItemToActivity({ distanceKm: 4.14, listing: listing(o) });
  return renderToStaticMarkup(
    <ActivityDetail activity={a} occurrenceId={a.id} backHref="/search" backLabel="Back" />);
};

/** Everything from the cluster's opening tag to the FreshnessStamp wrapper that follows it. */
function cluster(html: string): string {
  const start = html.indexOf('<div class="kf-detail__actions">');
  expect(start, 'the hero cluster must render').toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('kf-statrow', start));
}

function actionbar(html: string): string {
  const start = html.indexOf('<div class="kf-actionbar">');
  expect(start, 'the action bar must render').toBeGreaterThan(-1);
  return html.slice(start);
}

const BLOCKED: StatusState[] = ['cancelled', 'postponed'];

describe('🔴 the copy contract — the button says "Maps", never "Directions"', () => {
  it('labels the control "Maps"', () => {
    expect(cluster(render())).toContain('>Maps<');
  });

  it('never promises directions, navigation, or a route', () => {
    // `locationUrl` is a maps SEARCH for all but a sliver of listings. Each of these claims a
    // precision the URL does not have. If a future round wants one of them, it needs a verified
    // pin first — and this assertion is where that argument has to be had.
    const html = render();
    for (const overclaim of [
      'Directions', 'directions', 'Get directions', 'Navigate', 'Route', 'Take me there',
    ]) {
      expect(html, `must not claim "${overclaim}"`).not.toContain(overclaim);
    }
  });
});

describe('🔴 a blocked session makes the SOURCE claim, never the booking one', () => {
  for (const status of BLOCKED) {
    it(`${status}: the hero link points at the source URL even when a bookingUrl exists`, () => {
      const html = render({ statusState: status, bookingUrl: BOOKING_URL });
      const hero = html.slice(html.indexOf('class="kf-detail__source"'));
      expect(hero.slice(0, 200)).toContain(SOURCE_URL);
    });

    it(`${status}: the dead booking URL appears NOWHERE on the page`, () => {
      // The bar renders its disabled button instead of the primary, so once the hero stops
      // using it the booking URL should be absent from the document entirely.
      expect(render({ statusState: status, bookingUrl: BOOKING_URL })).not.toContain(BOOKING_URL);
    });

    it(`${status}: the hero label says "View official source", not a booking invitation`, () => {
      const html = render({ statusState: status, bookingUrl: BOOKING_URL });
      expect(cluster(html)).toContain('View official source');
      // mapBooking() forces booking='none' for a blocked status, so bookingTag() returns '' and
      // bookLabel falls back to this literal — which is what used to render here.
      expect(html, 'the old fallback label must be gone').not.toContain('View booking page');
    });

    it(`${status}: the action bar still refuses the action`, () => {
      expect(actionbar(render({ statusState: status, bookingUrl: BOOKING_URL }))).toContain('not available');
    });
  }

  it('does NOT over-apply: a live session with a bookingUrl still gets the booking affordance', () => {
    // The fix must be scoped to blocked statuses. If it leaked, every bookable listing would
    // lose its booking link — a far larger regression than the bug it fixes.
    const html = render({ statusState: 'bookable_open', bookingUrl: BOOKING_URL });
    expect(cluster(html)).toContain(BOOKING_URL);
    expect(cluster(html)).toContain('Bookable now');
    expect(actionbar(html)).toContain(BOOKING_URL);
  });
});

describe('the three controls sit in one cluster in the hero', () => {
  const html = render();

  it('holds the phone, the source link and Maps as siblings', () => {
    const row = cluster(html);
    expect(row).toContain('kf-detail__contact');
    expect(row).toContain('class="kf-detail__source"');
    expect(row).toContain('class="kf-detail__map"');
  });

  it('orders them call → source → map', () => {
    const row = cluster(html);
    expect(row.indexOf('kf-detail__contact')).toBeLessThan(row.indexOf('kf-detail__source'));
    expect(row.indexOf('kf-detail__source')).toBeLessThan(row.indexOf('kf-detail__map'));
  });

  it('sits above the stat row — the cluster is hero furniture, not a footer', () => {
    expect(html.indexOf('kf-detail__actions')).toBeLessThan(html.indexOf('kf-statrow'));
  });

  it('🔴 Maps has LEFT the action bar — it is in one place, not two', () => {
    const bar = actionbar(html);
    expect(bar).not.toContain(MAPS_URL);
    expect(bar).not.toContain('Maps');
    expect((html.match(new RegExp(MAPS_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length)
      .toBe(1);
  });

  it('opens both outbound controls in a new tab, and says so to a screen reader', () => {
    expect((html.match(/ \(opens in a new tab\)/g) ?? []).length).toBe(2);
    // The glyph is decoration; the sentence is the announcement.
    expect(html).toContain('<span aria-hidden="true">↗</span>');
  });

  it('keeps rel="noreferrer noopener" on the Maps link like every other outbound link here', () => {
    expect(html).toMatch(/class="kf-detail__map"[^>]*rel="noreferrer noopener"/);
  });
});

describe('🔴 no locationUrl renders no Maps control at all — not an empty or dead one', () => {
  // Populated for all but a sliver of listings, which is exactly why the guard rots quietly:
  // an admin-created listing can carry neither a location URL nor an address.
  const html = render({ locationUrl: null });

  it('drops the control entirely', () => {
    expect(html).not.toContain('kf-detail__map');
    expect(html).not.toContain('Maps');
  });

  it('leaves the rest of the cluster intact', () => {
    const row = cluster(html);
    expect(row).toContain('kf-detail__contact');
    expect(row).toContain('class="kf-detail__source"');
  });
});

describe('🔴 the source control is restyled, not double-styled', () => {
  // The failure this catches is APPENDING the new rule instead of REPLACING the old one: the
  // old `.kf a.kf-detail__source` set `text-decoration: underline`, which would survive and
  // draw a line through the middle of the new bordered control.
  const css = readFileSync(fileURLToPath(new URL('../../app/preview/preview.css', import.meta.url)), 'utf8');

  it('declares the control exactly once, as a shared rule with the map control', () => {
    const blocks = css.match(/^\.kf a\.kf-detail__source[^{]*\{[^}]*\}/gm) ?? [];
    expect(blocks.length, 'one chrome rule + one sizing rule').toBe(2);
    expect(css).toContain('.kf a.kf-detail__source,\n.kf a.kf-detail__map {');
  });

  it('carries no underline anywhere in the source control\'s own rules', () => {
    const blocks = (css.match(/^\.kf a\.kf-detail__source[^{]*\{[^}]*\}/gm) ?? []).join('\n');
    expect(blocks).not.toContain('text-decoration: underline');
    expect(blocks).not.toContain('text-underline-offset');
    expect(blocks).toContain('text-decoration: none');
  });

  it('keeps the (0,2,1) specificity that `.kf a { color: inherit }` requires', () => {
    // A bare `.kf-detail__source` rule is (0,1,0) and loses to `.kf a` at (0,1,1) — the trap
    // the stylesheet already documents twice, for .kf-btn--primary and for this control.
    expect(css).not.toMatch(/^\.kf-detail__(source|map)\s*[,{]/m);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// A LISTING WITH NO SOURCE URL (2026-09-11, QA hardening)
//
// The cluster above guards Maps on `locationUrl` and says why: "an admin-created listing can
// carry neither a location URL nor an address, and a Maps button with no destination is worse
// than no button." The control sitting immediately beside it had no such guard, and could not
// have had a working one, because the mapper never delivered an absence to guard against:
//
//   search-api.ts   const sourceUrl = l.sourceUrl ?? '#'
//
// `source_url` is nullable (migration 0004) and the admin listing form writes null for a blank
// field (app/admin/listings/_lib/vocab.ts -> optText), so the null is reachable in production.
// `'#'` is a VALID href, not an inert placeholder, so it passed every truthiness check and
// rendered as a live control twice over:
//
//   • the hero's bordered "View official source" button carries target="_blank" — tapping it
//     opened a BLANK NEW TAB;
//   • the sticky bar's filled primary CTA — the one do-action on the page — did nothing.
//
// `Activity.sourceUrl` now carries the null. These assertions pin the absence, and pin that
// the fix did not leak into the overwhelmingly common case where a source URL exists.
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** The literal placeholder that must never reach the document again, in either href form. */
const DEAD_HREFS = ['href="#"', "href='#'", 'href=""'];

describe('🔴 no sourceUrl renders no source control — not a dead one', () => {
  const html = render({ sourceUrl: null, bookingUrl: null });

  it('drops the hero source control entirely', () => {
    expect(cluster(html)).not.toContain('kf-detail__source');
    expect(html).not.toContain('View official source');
  });

  it('renders no href that goes nowhere', () => {
    for (const dead of DEAD_HREFS) expect(html, `must not render ${dead}`).not.toContain(dead);
  });

  it('renders no action bar at all rather than an empty sticky strip', () => {
    // The bar became a single-action bar when Maps moved into the hero. With no action left to
    // put in it, the bar is a 45px bordered artefact pinned to the bottom of the viewport.
    expect(html).not.toContain('kf-actionbar');
    expect(html).not.toContain('kf-btn--primary');
  });

  it('leaves the rest of the cluster intact — phone and Maps are unaffected', () => {
    const row = cluster(html);
    expect(row).toContain('kf-detail__contact');
    expect(row).toContain('(604) 555-0142');
    expect(row).toContain('class="kf-detail__map"');
    expect(row).toContain('>Maps<');
  });
});

describe('🔴 an empty-string sourceUrl is the same fact as none', () => {
  // `href=""` resolves to the CURRENT page, so with target="_blank" it opens a duplicate of the
  // activity page in a new tab. `??` let it straight through — only null was ever collapsed.
  for (const blank of ['', '   ']) {
    it(`${JSON.stringify(blank)} renders no control and no dead href`, () => {
      const html = render({ sourceUrl: blank, bookingUrl: null });
      expect(cluster(html)).not.toContain('kf-detail__source');
      for (const dead of DEAD_HREFS) expect(html).not.toContain(dead);
      expect(html).not.toContain('kf-actionbar');
    });
  }
});

describe('🔴 a BLOCKED listing with no sourceUrl never falls back to the booking URL', () => {
  // The nastiest combination, and the one the shipped fix's own reasoning demands: a blocked
  // session pins the hero to the SOURCE url, so a missing source url must render nothing —
  // never quietly re-admit the dead booking page the blocked-state fix exists to remove.
  for (const status of BLOCKED) {
    it(`${status}: no hero control, and the dead booking URL is nowhere on the page`, () => {
      const html = render({ statusState: status, sourceUrl: null, bookingUrl: BOOKING_URL });
      expect(cluster(html)).not.toContain('kf-detail__source');
      expect(html).not.toContain(BOOKING_URL);
      for (const dead of DEAD_HREFS) expect(html).not.toContain(dead);
    });

    it(`${status}: the bar still renders and still refuses the action`, () => {
      // The bar's disabled ghost does not depend on an href, so it must survive the guard —
      // dropping it would delete the page's only statement that this session is not happening.
      const html = render({ statusState: status, sourceUrl: null, bookingUrl: BOOKING_URL });
      expect(html).toContain('kf-actionbar');
      expect(actionbar(html)).toContain('not available');
    });
  }
});

describe('the guard does NOT over-apply', () => {
  it('a listing with a real sourceUrl keeps its hero control and its primary CTA', () => {
    const html = render();
    expect(cluster(html)).toContain('class="kf-detail__source"');
    expect(cluster(html)).toContain(SOURCE_URL);
    expect(actionbar(html)).toContain('kf-btn--primary');
    expect(actionbar(html)).toContain(SOURCE_URL);
  });

  it('a listing with no sourceUrl but a real bookingUrl still gets both', () => {
    // sourceHref falls through to bookingUrl for a live status, so this listing is fully
    // actionable and must be untouched by a guard aimed at listings with neither.
    const html = render({ sourceUrl: null, bookingUrl: BOOKING_URL, statusState: 'bookable_open' });
    expect(cluster(html)).toContain(BOOKING_URL);
    expect(actionbar(html)).toContain(BOOKING_URL);
    expect(actionbar(html)).toContain('kf-btn--primary');
  });
});
