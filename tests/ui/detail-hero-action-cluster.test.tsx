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

/** How many times a literal occurs in the document. Used to pin "exactly one" claims. */
function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/**
 * preview.css with comments removed, which is the only safe text to assert declarations
 * against. Two reasons, both of which produced false results before this existed:
 *   • the comments QUOTE selectors — `.kf a { color: inherit }` is explained in four places —
 *     so "this rule is gone" was true of the rule and false of the file;
 *   • those quotes contain BRACES, so naive slice-to-the-next-`}` truncated a rule at its own
 *     documentation and reported declarations below it as missing.
 */
function cssNoComments(): string {
  const raw = readFileSync(fileURLToPath(new URL('../../app/preview/preview.css', import.meta.url)), 'utf8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The declaration block for a selector that begins a line, up to its closing brace. */
function cssBlock(css: string, selectorLineStart: string): string {
  const i = css.indexOf(`\n${selectorLineStart}`);
  expect(i, `${selectorLineStart} must exist`).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf('}', i));
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
    // The bar used to carry a second copy of this href. Since 2026-09-11 it carries no link at
    // all, so the affordance being present is a claim about the HERO — and about it alone.
    expect(count(html, BOOKING_URL), 'the booking href appears exactly once').toBe(1);
    expect(html).not.toContain('kf-actionbar');
  });
});

describe('the three controls sit in one cluster in the hero', () => {
  const html = render();

  it('holds the phone, the source link and Maps as siblings', () => {
    const row = cluster(html);
    // Was `kf-detail__contact` — the wrapper that carried the phone AND its caveat into the
    // row. The caveat moved below the group on 2026-09-11 and the wrapper went with it, so the
    // phone CONTROL is the cluster member and is what these structural guards should name.
    expect(row).toContain('class="kf-phone"');
    expect(row).toContain('class="kf-detail__source"');
    expect(row).toContain('class="kf-detail__map"');
  });

  it('orders them call → source → map', () => {
    const row = cluster(html);
    expect(row.indexOf('class="kf-phone"')).toBeLessThan(row.indexOf('kf-detail__source'));
    expect(row.indexOf('kf-detail__source')).toBeLessThan(row.indexOf('kf-detail__map'));
  });

  it('sits above the stat row — the cluster is hero furniture, not a footer', () => {
    expect(html.indexOf('kf-detail__actions')).toBeLessThan(html.indexOf('kf-statrow'));
  });

  it('🔴 Maps is in one place, not two', () => {
    // Originally: "Maps has LEFT the action bar". A live listing now has no action bar for it
    // to have left, so the surviving claim is the one that always mattered — one control, once.
    expect(html).not.toContain('kf-actionbar');
    expect(count(html, MAPS_URL)).toBe(1);
    expect(count(html, '>Maps<')).toBe(1);
  });

  it('opens both outbound controls in a new tab, and says so to a screen reader', () => {
    // Scoped to the CLUSTER. The page carries a third announcement since 2026-09-11 — the
    // provenance sentence's source link — and this test is about the two controls in the row.
    expect((cluster(html).match(/ \(opens in a new tab\)/g) ?? []).length).toBe(2);
    expect((html.match(/ \(opens in a new tab\)/g) ?? []).length).toBe(3);
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
    expect(row).toContain('class="kf-phone"');
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
    // Chrome + sizing + (since the 2026-09-11 recolour) one hover step. Three named rules,
    // each doing one job. A fourth means the control is being styled in two places again,
    // which is the failure this guard was written for.
    expect(blocks.length, 'chrome + sizing + hover').toBe(3);
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
    expect(row).toContain('class="kf-phone"');
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
  it('a listing with a real sourceUrl keeps its hero control', () => {
    const html = render();
    expect(cluster(html)).toContain('class="kf-detail__source"');
    expect(cluster(html)).toContain(SOURCE_URL);
  });

  it('a listing with no sourceUrl but a real bookingUrl still gets the hero control', () => {
    // sourceHref falls through to bookingUrl for a live status, so this listing is fully
    // actionable and must be untouched by a guard aimed at listings with neither.
    const html = render({ sourceUrl: null, bookingUrl: BOOKING_URL, statusState: 'bookable_open' });
    expect(cluster(html)).toContain(BOOKING_URL);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// ONE SOURCE CONTROL, AND THREE GREEN ONES (Jon, 2026-09-11)
//
// Two changes, and each one reverses a decision this file already documents — which is exactly
// why they are pinned here rather than left to a screenshot:
//
//  1. THE DUPLICATE IS GONE. "View official source" rendered twice on every listing: once as
//     the hero's bordered control, once as the sticky bar's filled CTA, same href, same words.
//     ActivityDetail.tsx's own note argued FOR the duplicate on thumb-reach grounds. Jon has
//     ruled the other way: the hero keeps it, the bar's copy is deleted. The bar survives for
//     the blocked refusal alone.
//
//  2. THE CLUSTER IS GREEN. `--leaf` fill, `--forest-ink` label — the brand's existing primary
//     pair, lifted from .kf-btn--primary, not a new colour. Both are RAW palette values that do
//     not flip with the colour scheme, so the pair is 7.61:1 in light and dark alike.
//
// The regression each guards is the same shape: a future round re-adding the bar's CTA "for
// reach", or restyling the cluster with a token that flips and quietly drops contrast in one
// scheme only.
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('🔴 "View official source" appears exactly ONCE on the page', () => {
  it('renders one source control, in the hero, for an ordinary listing', () => {
    const html = render();
    expect(count(html, 'View official source')).toBe(1);
    expect(cluster(html)).toContain('View official source');
  });

  it('renders one source CONTROL, with the provenance link as the only other reference', () => {
    // The href appears twice on purpose since 2026-09-11: the hero's control, and the inline
    // text link on the domain name in the Source & freshness sentence. What must never come
    // back is a second BUTTON saying the same words — so the count that matters is the label's.
    const html = render();
    expect(count(html, SOURCE_URL), 'hero control + provenance text link').toBe(2);
    expect(count(html, 'View official source'), 'exactly one control').toBe(1);
    expect(count(html, 'class="kf-detail__source"')).toBe(1);
    expect(count(html, 'class="kf-srclink"')).toBe(1);
  });

  it('holds when the label comes from a booking tag rather than the source copy', () => {
    // The duplicate was never only the literal "View official source" — with a bookingUrl the
    // bar and the hero both rendered the booking tag instead. Same defect, different words.
    const html = render({ bookingUrl: BOOKING_URL, statusState: 'bookable_open' });
    expect(count(html, BOOKING_URL)).toBe(1);
  });
});

describe('🔴 the sticky bar carries no link — it is a refusal bar or it is absent', () => {
  it('an ordinary listing gets no action bar and no primary CTA', () => {
    const html = render();
    expect(html).not.toContain('kf-actionbar');
    expect(html).not.toContain('kf-btn--primary');
  });

  for (const status of BLOCKED) {
    it(`${status}: the bar survives, carrying the disabled refusal and nothing else`, () => {
      // The one thing in the bar that is not a duplicate of the hero: a refusal. Deleting it
      // would remove the page's only statement, besides the honesty block, that the session
      // is not happening — so the duplicate removal must not take it with it.
      const bar = actionbar(render({ statusState: status }));
      expect(bar).toContain('not available');
      expect(bar).toContain('kf-btn--ghost');
      expect(bar).not.toContain('kf-btn--primary');
      expect(bar).not.toContain('View official source');
    });
  }
});

describe('🔴 the hero cluster is Leaf-filled, on the brand pair and no other', () => {
  const css = cssNoComments();
  const block = (sel: string) => cssBlock(css, sel);

  const SOURCE_AND_MAP = '.kf a.kf-detail__source,\n.kf a.kf-detail__map {';

  it('fills the source and Maps controls with --leaf and labels them --forest-ink', () => {
    const b = block(SOURCE_AND_MAP);
    expect(b).toContain('background: var(--leaf);');
    expect(b).toContain('color: var(--forest-ink);');
    expect(b).not.toContain('var(--surface)');
  });

  it('fills the phone control the same way', () => {
    const b = block('.kf-phone {');
    expect(b).toContain('background: var(--leaf);');
    expect(b).not.toContain('var(--surface)');
    // The colour cannot live in this (0,1,0) rule — `.kf a { color: inherit }` is (0,1,1) and
    // beats it, which is why the old `color: var(--info-text)` here never rendered.
    expect(b).not.toContain('color:');
    expect(block('.kf a.kf-phone {')).toContain('color: var(--forest-ink);');
  });

  it('invents no new green — every colour used is an existing token', () => {
    for (const sel of [SOURCE_AND_MAP, '.kf-phone {', '.kf a.kf-phone {']) {
      const b = block(sel);
      // No raw hex, rgb() or named colour may appear in these blocks. A literal is how a
      // fourth green gets into a palette that already has three.
      expect(b, `${sel} must not hard-code a colour`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    }
  });

  it('uses ONLY --leaf / --leaf-hover / --forest-ink, the .kf-btn--primary pair', () => {
    // .kf-btn--primary is the brand's primary control and the token source this borrows from.
    // If that rule ever stops using --leaf, this cluster is no longer reusing anything.
    expect(block('.kf-btn--primary {')).toContain('background: var(--leaf);');
    expect(block('.kf a.kf-btn--primary {')).toContain('color: var(--forest-ink);');
  });

  it('🔴 keeps every tap target at the 44px floor — colour changed, geometry did not', () => {
    for (const sel of [SOURCE_AND_MAP, '.kf-phone {']) {
      const b = block(sel);
      expect(b, `${sel} keeps its 44px floor`).toContain('min-height: 44px');
      expect(b, `${sel} keeps its padding`).toContain('padding: 10px 14px');
    }
  });

  it('hovers to --leaf-hover, the same step .kf-btn--primary takes', () => {
    expect(block('.kf a.kf-phone:hover,')).toContain('background: var(--leaf-hover);');
    expect(block('.kf-btn--primary:hover {')).toContain('background: var(--leaf-hover);');
  });
});

describe('🔴 the 88px reserved for the bar is spent only when there is a bar', () => {
  const css = cssNoComments();

  it('does not reserve bar height unconditionally', () => {
    // The bar is now absent on all but blocked listings. An unconditional 88px would be blank
    // page below the last panel on every other listing — a layout fault, not breathing room.
    const base = css.slice(css.indexOf('\n.kf-detail {'), css.indexOf('}', css.indexOf('\n.kf-detail {')));
    expect(base).toContain('padding-bottom: 24px');
    expect(base).not.toContain('88px');
  });

  it('reserves it when a bar is actually present', () => {
    expect(css).toContain('.kf-detail:has(> .kf-actionbar) {');
  });

  it('desktop still drops the reservation — the :has() rule must not out-specify it', () => {
    // `.kf-detail:has(...)` is (0,2,0) and beats the bare `.kf-detail` (0,1,0) the >=1024px
    // block uses to zero this out, so that block has to name both.
    expect(css).toContain('  .kf-detail,\n  .kf-detail:has(> .kf-actionbar) {\n    padding-bottom: 24px;');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE CLUSTER HOLDS ITS EDGE, AND THE SOURCE STAYS REACHABLE (Jon, 2026-09-11)
//
// Three follow-ons from the recolour, all of which exist because a FILLED control makes a
// layout fault legible that an outlined one hid:
//
//  • the front-desk caveat rode inside the flex row, standing the phone item ~68px taller than
//    its neighbours and opening a hole beside it;
//  • Maps was `flex: 0 1 auto` and sat as a ~92px stub on its own row at 320px;
//  • deleting the bar's source CTA left the source reachable only from the top of a ~1500px
//    page, so the domain in the provenance sentence became the link instead.
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('🔴 the front-desk caveat is below the group, and still bound to the number', () => {
  const html = render();

  it('does not render inside the action row', () => {
    // Inside the row it is a flex item two lines taller than everything beside it. cluster()
    // deliberately runs on to the stat row, so "inside" is expressed as ordering: the caveat
    // must follow every control in the row, not sit between them.
    const row = cluster(html);
    const note = row.indexOf('kf-phone__note');
    expect(note).toBeGreaterThan(-1);
    for (const control of ['class="kf-phone"', 'kf-detail__source', 'kf-detail__map']) {
      expect(row.indexOf(control), `the caveat must follow ${control}`).toBeLessThan(note);
    }
    // And it is outside the flex container itself — the CSS selector that positions it is a
    // SIBLING combinator, so if it were still a child it would lose its spacing silently.
    expect(row.slice(note - 6, note)).not.toContain('<div');
  });

  it('renders immediately after the row, before the freshness stamp', () => {
    const row = html.indexOf('kf-detail__actions');
    const note = html.indexOf('kf-phone__note');
    const stamp = html.indexOf('kf-stamp');
    expect(note).toBeGreaterThan(row);
    expect(note).toBeLessThan(stamp);
  });

  it('🔴 keeps the aria tie — the caveat is WHY the number could ship', () => {
    // The only thing the move could have broken. aria-describedby is an ID reference, so a
    // screen-reader user hears the qualifier on the link regardless of where the <p> sits.
    expect(html).toMatch(/aria-describedby="kf-phone-note"/);
    expect(html).toMatch(/id="kf-phone-note"/);
  });

  it('🔴 does not reword it — the copy is a contract (venue-phone.test.tsx)', () => {
    expect(html).toContain('front desk');
    expect(html).toContain('not a line for this specific session');
    expect(html).not.toContain('Call Kitsilano Pool');
  });

  it('renders no caveat when there is no number to qualify', () => {
    const html2 = render({ venuePhone: null });
    expect(html2).not.toContain('kf-phone__note');
    expect(html2).not.toContain('front desk');
  });
});

describe('🔴 every control in the cluster grows to fill its row', () => {
  const css = cssNoComments();

  it('gives the phone and Maps a growing flex, not a fixed one', () => {
    const i = css.indexOf('\n.kf a.kf-phone,\n.kf a.kf-detail__map {');
    expect(i, 'the shared growth rule must exist').toBeGreaterThan(-1);
    expect(css.slice(i, css.indexOf('}', i))).toContain('flex: 1 1 auto');
  });

  it('🔴 Maps no longer declares the `flex: 0 1 auto` that stranded it at 320px', () => {
    const i = css.indexOf('\n.kf a.kf-detail__map {');
    expect(css.slice(i, css.indexOf('}', i))).not.toContain('flex: 0 1 auto');
  });

  it('the source control was already growing and stays that way', () => {
    const i = css.indexOf('\n.kf a.kf-detail__source {');
    expect(css.slice(i, css.indexOf('}', i))).toContain('flex: 1 1 140px');
  });

  it('the caveat wrapper rule is gone, not orphaned', () => {
    // A rule for a class no element carries is the kind of thing that gets "restored" later.
    expect(css).not.toContain('.kf-detail__actions > .kf-detail__contact');
    expect(css).not.toMatch(/^\.kf-detail__contact\s*\{/m);
  });

  it('the caveat is constrained to a readable measure where it now sits', () => {
    const i = css.indexOf('\n.kf-detail__actions + .kf-phone__note {');
    expect(i).toBeGreaterThan(-1);
    expect(css.slice(i, css.indexOf('}', i))).toContain('max-width: 38ch');
  });
});

describe('🔴 the source is still reachable from the bottom of the page', () => {
  it('links the source NAME in the provenance sentence', () => {
    const html = render();
    expect(html).toContain('class="kf-srclink"');
    const link = html.slice(html.indexOf('class="kf-srclink"'));
    expect(link.slice(0, 200)).toContain(SOURCE_URL);
  });

  it('sits in the Source & freshness panel, well below the hero control', () => {
    const html = render();
    expect(html.indexOf('kf-detail__source')).toBeLessThan(html.indexOf('kf-srclink'));
    expect(html.indexOf('Source &amp; freshness')).toBeLessThan(html.indexOf('kf-srclink'));
  });

  it('🔴 is a text link, NOT a second "View official source" button', () => {
    // The entire point. A repeated CTA here is the duplicate this commit exists to delete.
    const html = render();
    expect(count(html, 'View official source')).toBe(1);
    const link = html.slice(html.indexOf('<a class="kf-srclink"'));
    expect(link.slice(0, 300)).not.toContain('View official source');
    expect(link.slice(0, 300)).not.toContain('kf-btn');
  });

  it('🔴 points at the SOURCE url, never the booking url', () => {
    // The hero falls through to bookingUrl; this panel makes the provenance claim, so it must
    // resolve to the page that makes that claim or to nothing.
    const html = render({ bookingUrl: BOOKING_URL, statusState: 'bookable_open' });
    const link = html.slice(html.indexOf('<a class="kf-srclink"'));
    expect(link.slice(0, 200)).toContain(SOURCE_URL);
    expect(link.slice(0, 200)).not.toContain(BOOKING_URL);
  });

  it('🔴 renders no link at all when there is no source url', () => {
    // hostLabel() returns the literal "fixture source" for a null URL — a known, separately
    // tracked copy defect. Linking it would make a bad label into a dead link as well.
    const html = render({ sourceUrl: null, bookingUrl: null });
    expect(html).not.toContain('kf-srclink');
    for (const dead of DEAD_HREFS) expect(html).not.toContain(dead);
  });

  it('announces the new tab, like every other outbound link on the page', () => {
    const html = render();
    const link = html.slice(html.indexOf('<a class="kf-srclink"'));
    expect(link.slice(0, 300)).toContain('rel="noreferrer noopener"');
    expect(link.slice(0, 400)).toContain('(opens in a new tab)');
  });

  it('is styled as body-copy link, not as a control', () => {
    const css = cssNoComments();
    const i = css.indexOf('\n.kf a.kf-srclink {');
    expect(i, 'the (0,2,1) rule `.kf a` requires').toBeGreaterThan(-1);
    const b = css.slice(i, css.indexOf('}', i));
    expect(b).toContain('text-decoration: underline');
    expect(b).toContain('color: var(--info-text)');
    // No box. A 44px target inside a <p> of running text breaks the line box.
    expect(b).not.toContain('min-height');
    expect(b).not.toContain('border:');
    expect(b).not.toContain('background');
  });
});

describe('🔴 the cluster\'s contrast does not depend on the colour scheme', () => {
  // The whole safety argument for filling three controls with --leaf is that the fill and the
  // label are RAW palette values: design-tokens.css says "Raw palette tokens (e.g. --kf-leaf)
  // are fixed brand values and never flip", and .kf-btn--primary's own note relies on exactly
  // that to claim 7.61:1 "in BOTH schemes". If a future dark-mode pass ever overrides either
  // token, that claim silently becomes false for half the users and nothing else would catch it.
  const tokens = readFileSync(fileURLToPath(new URL('../../app/design-tokens.css', import.meta.url)), 'utf8');
  const darkBlock = tokens.slice(tokens.indexOf('@media (prefers-color-scheme: dark)'));

  it('never redefines --kf-leaf or --kf-forest-ink for dark mode', () => {
    expect(darkBlock).not.toMatch(/--kf-leaf\s*:/);
    expect(darkBlock).not.toMatch(/--kf-forest-ink\s*:/);
  });

  it('keeps both as literal palette values, not aliases onto something that flips', () => {
    expect(tokens).toMatch(/--kf-leaf:\s*#[0-9a-fA-F]{6}/);
    expect(tokens).toMatch(/--kf-forest-ink:\s*#[0-9a-fA-F]{6}/);
  });
});
