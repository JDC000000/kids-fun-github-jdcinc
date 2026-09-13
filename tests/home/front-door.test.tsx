// tests/home/front-door.test.tsx — the home page AS THE SMS FRONT DOOR (TSD v1.2 §9 M2 + T3.3).
//
// ═══ WHAT THIS FILE GUARDS THAT tests/home/sms-offer.test.tsx DOES NOT ═══
// That file owns the M1 mechanism: the fail-safe branch (AC-12) and the two funnel events
// (AC-09). It is deliberately indifferent to where anything sits on the page. THIS file owns the
// M2 STRUCTURE — the 90/10 re-prioritisation Jon asked for ("it should heavily promote SMS. this
// will be 90% of it. below the fold is ok to allow for a search engine and keep the site active")
// — and the structure is the requirement, not a presentation detail:
//
//   · a search affordance that creeps back above the offer fails AC-01/AC-05 silently, and
//     nothing in the M1 file would notice, because the offer would still be present and correct.
//   · the profile panel's relocation (T2.4/T2.5) is invisible to every render assertion, because
//     ChildProfilePrompt returns null on the server in EITHER place. Removing it from the home
//     page without landing it on /search would take the product's only profile-capture surface
//     offline and show up as nothing at all until age personalisation quietly stopped working.
//   · the compliance block (T2.9) is the one place on this page where "looks right" and "is
//     right" come apart: paraphrased disclosures read perfectly and are a version-drift bug.
//
// ═══ THE MUTATION MATRIX (standing F-4 lesson: a guard is not done until a deliberate ═══
// ═══ regression proves the test catches it). Every row below was applied to the real ═══
// ═══ source, the suite run, and the source restored. All 13 turned this file red. ═══
//
//  #    guard                                                          mutation that kills it
//  H1   the offer is the FIRST block on the page                       move <ThreeThings/> above it
//  H2   no search affordance renders before the weight boundary        move the form back to the hero
//  H3   search is still genuinely ON the page (not menu-only)          delete the search <form>
//  H4   the category tiles are in the search block, not the fold       move <ul.kf-home__tiles> up
//  H5   quick-start chips render nowhere on the home page              re-add QUICK_START_FILTERS
//  H6   ChildProfilePrompt is off the home page                        re-import it into app/page.tsx
//  H7   …and is ON /search                                             drop it from app/search/page.tsx
//  H8   the proof block is framed as the weekly text                   revert the heading
//  H9   the proof block is non-interactive (G1 Q1)                     re-add a slot escape link
//  H10  the carrier disclosures are the CONSTANTS, verbatim            retype one as a paraphrase
//  H11  sender identity + a real tel: link are present                 drop the identity line
//  H12  privacy and terms are one step away                            drop either link
//  H13  title/description describe the offer, not the guide            restore the old metadata
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReactElement } from 'react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// Same stub, same reason, as tests/nav-destinations.test.tsx: <ThreeThings /> is an async server
// component and renderToStaticMarkup is the legacy synchronous renderer. What the stub costs is
// paid back directly — the block is rendered FOR REAL in its own describe at the foot of this
// file, which is where H8 and H9 live.
vi.mock('../../app/_components/ThreeThings', () => ({
  ThreeThings: () => <div data-testid="three-things-stub" />,
}));

// One level above the pg-backed writer, so this file observes the page without a database.
const emitEvent = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ ok: true })));
vi.mock('../../lib/analytics/emit', () => ({ emitEvent }));

const { default: Home, metadata } = await import('../../app/page');
const { ThreeThings } = await vi.importActual<typeof import('../../app/_components/ThreeThings')>(
  '../../app/_components/ThreeThings',
);
const { QUICK_START_FILTERS, destinationHref, liveCategoryDestinations } = await import(
  '../../app/_lib/nav-destinations'
);
const {
  CARRIER_DISCLOSURES,
  SENDER_IDENTITY,
  SUPPORT_LINE,
  SUPPORT_PHONE_HREF,
} = await import('../../lib/sms/consent-copy');
const { START_HEADING } = await import('../../app/sms/start/copy');

function sourceOf(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

/** Visible text, with the entities React escapes decoded and whitespace normalised. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
}

/** Where a marker first appears in the document, or -1. Document order IS page order here:
 *  every block is a sibling section in one column, so "earlier in the HTML" is "higher up". */
function at(html: string, marker: string): number {
  return html.indexOf(marker);
}

async function renderHome(): Promise<string> {
  return renderToStaticMarkup((await Home()) as ReactElement);
}

beforeEach(() => {
  vi.stubEnv('SMS_SENDING_ENABLED', 'false');
  vi.stubEnv('SMS_SIGNUP_ENABLED', 'true');
  emitEvent.mockReset();
  emitEvent.mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AC-01 / AC-02 / AC-15 — the first screen is the offer, and it answers the five questions', () => {
  it('leads with Jon’s own wording, reused rather than rewritten', async () => {
    // T2.1's instruction is explicit: start from `START_HEADING`, which Jon revised himself on
    // 2026-09-11. Asserted against the CONSTANT, so a rewrite here has to be a deliberate edit
    // to the string he owns rather than a quiet second version of it on another surface.
    expect(textOf(await renderHome())).toContain(START_HEADING);
  });

  it('answers C-02…C-05 as labelled facts, with Metro Vancouver stated (AC-15, R-03)', async () => {
    const text = textOf(await renderHome());
    for (const label of ['How often', 'What you get', 'Where', 'Cost']) {
      expect(text, `the first screen must answer "${label}"`).toContain(label);
    }
    // AC-15 is not a nice-to-have: an out-of-area parent who hands over a number for a service
    // that cannot cover them is the failure R-03 names, and this is the one line that stops it.
    expect(text).toContain('Metro Vancouver');
  });

  it('🔴 H1 — the offer is the FIRST block on the page, above everything else', async () => {
    const html = await renderHome();
    const offer = at(html, '<section class="kf-home__sms');
    expect(offer).toBeGreaterThan(-1);
    // The proof block is the stub declared at the top of this file — it is <ThreeThings />'s
    // POSITION that is being asserted here, not its contents, and the real component is
    // rendered in its own describe below.
    for (const later of ['three-things-stub', 'kf-home__trust', 'kf-home__utility']) {
      expect(at(html, later), `${later} must come after the offer`).toBeGreaterThan(offer);
    }
    // …and in that order, which is the decided page order (TSD §6.1): offer → proof → trust →
    // the weight boundary → search.
    expect(at(html, 'three-things-stub')).toBeLessThan(at(html, 'kf-home__trust'));
    expect(at(html, 'kf-home__trust')).toBeLessThan(at(html, 'kf-home__utility'));
  });

  it('AC-03 — exactly one primary action, and Leaf is spent only on it', async () => {
    const html = await renderHome();
    expect(html.match(/kf-home__sms-cta/g)).toHaveLength(1);
  });
});

describe('AC-05 / AC-07 + the fold test — search is below the boundary, but genuinely present', () => {
  it('🔴 H2 — NO search affordance renders before the weight boundary', async () => {
    // THE HARD HALF OF THE 90/10 (TSD §6.2). The e2e spec measures this in pixels at 390×844;
    // this asserts the structural fact that makes the pixel measurement possible, in the
    // blocking unit lane. A search input, a category tile or a quick-start chip that creeps
    // back above the boundary fails here first.
    const html = await renderHome();
    const boundary = at(html, 'kf-home__utility');
    expect(boundary).toBeGreaterThan(-1);
    for (const affordance of ['action="/search"', 'kf-home__search', 'kf-home__tiles', 'kf-home__tile']) {
      const first = at(html, affordance);
      expect(first, `"${affordance}" must not render above the weight boundary`).toBeGreaterThan(boundary);
    }
  });

  it('🔴 H3 — the search form is still on the page, still a plain GET to /search', async () => {
    // AC-07. "Below the fold" was a relocation instruction, not a removal one: a section that
    // exists but cannot be found fails this exactly as a deleted one would, which is why the
    // form is asserted as a real, unchanged, no-JavaScript GET rather than as a link.
    const html = await renderHome();
    expect(html).toContain('action="/search"');
    expect(html).toContain('method="get"');
    expect(html).toContain('name="q"');
    expect(html).toContain('role="search"');
  });

  it('🔴 H4 — the category tiles are inside the search block, compact and label-only', async () => {
    const html = await renderHome();
    const live = liveCategoryDestinations();
    // Still the shared list, in order, at the shared URLs — the tiles moved and shrank; the
    // vocabulary did not fork (app/_lib/nav-destinations.ts).
    expect(hrefs(html).filter((h) => h.startsWith('/search?q='))).toEqual(live.map(destinationHref));
    // Label-only: the captions are what made these tall, and height is the whole budget down
    // here. If a caption comes back, the block stops being compact and this says so.
    const text = textOf(html);
    for (const d of live) {
      expect(text).toContain(d.label);
      expect(text, `the compact tile must not restate "${d.caption}"`).not.toContain(d.caption);
    }
  });

  it('🔴 H5 — no quick-start chip renders on the home page at all (T2.7)', async () => {
    // They narrow a search rather than naming a destination, which makes them the least
    // valuable thing a 10% budget could be spent on. They stay on /search, where they work.
    // Derived from the shared constant, so a chip added there cannot slip back in here.
    const html = await renderHome();
    expect(QUICK_START_FILTERS.length, 'the constant must be non-empty or this proves nothing').toBeGreaterThan(0);
    for (const filter of QUICK_START_FILTERS) {
      expect(hrefs(html)).not.toContain(filter.href);
      expect(textOf(html)).not.toContain(filter.label);
    }
  });

  it('a keyboard user can reach search without traversing the whole offer', async () => {
    // The search block is deliberately at the END of a long page. The skip link is what stops
    // "below the fold" meaning "after four blocks of tabbing"; it is off-screen until focused,
    // so it costs the fold no height and renders no visible affordance in the first screen.
    const html = await renderHome();
    expect(html).toContain('kf-home__skip');
    expect(hrefs(html)).toContain('#kf-home-search');
    expect(html).toContain('id="kf-home-search"');
  });
});

describe('AC-06 / T2.5 — the profile panel left the home page and landed on /search', () => {
  // ASSERTED AGAINST THE SOURCE, DELIBERATELY, AND THIS IS THE ONLY WAY IT CAN BE ASSERTED HERE.
  // ChildProfilePrompt is a client island that returns null during server rendering in BOTH
  // places — it gates on `ready`, which is false until storage has been read. So a rendered-HTML
  // assertion would pass whether the component was mounted, unmounted, or deleted, and the
  // relocation this scope exists to guarantee would be invisible to it. The failure being
  // prevented is not cosmetic: it is the product losing its only profile-CAPTURE surface, which
  // silently strips age personalisation from /search for every new visitor (TSD §4.5, F-2/R-09).
  const home = sourceOf('../../app/page.tsx');
  const search = sourceOf('../../app/search/page.tsx');

  it('🔴 H6 — the home page no longer renders it', () => {
    expect(home).not.toContain('ChildProfilePrompt');
  });

  it('🔴 H7 — /search renders it, so the product still has a profile-capture surface', () => {
    expect(search).toContain("import { ChildProfilePrompt }");
    expect(search).toContain('<ChildProfilePrompt />');
  });

  it('🔴 H7b — …and BELOW the results, because the fold on /search is not this panel’s to spend', () => {
    // MEASURED, NOT PREFERRED. Mounted above the results (the obvious spot, next to the
    // ProfileAgeDefault that consumes it) the 317px panel moved the first result card from
    // 557px to 874px on a 390x664 phone — 316px below the fold, against a 560px chrome budget
    // with 3px of headroom. tests/e2e/public/search-above-the-fold.public.spec.ts went red on
    // all six phone descriptors. "The first result is on the first screen" is a shipped
    // guarantee of the SEARCH product; a capture panel for the SMS product may not spend it.
    //
    // This assertion is the cheap unit-lane sentinel for that e2e fact: it fails the moment the
    // panel moves back above the results, in the blocking lane, before anyone waits for a
    // browser to measure pixels.
    const prompt = search.indexOf('<ChildProfilePrompt />');
    expect(prompt).toBeGreaterThan(search.indexOf('<SearchResultsView'));
    expect(prompt).toBeGreaterThan(search.indexOf('<ProfileAgeDefault'));
  });

  it('the component itself was relocated, not duplicated or forked', () => {
    // One capture surface, not two. A second copy is how the two surfaces start disagreeing
    // about what they stored.
    expect(search.match(/<ChildProfilePrompt \/>/g)).toHaveLength(1);
  });
});

describe('AC-13 / AC-14 — compliance is reachable in one step, and LINKED OR REUSED, never restated', () => {
  it('🔴 H10 — every carrier disclosure is the exported constant, byte for byte', async () => {
    // THE FAILURE THIS PREVENTS IS NOT A TYPO. The consent wording is versioned
    // (CONSENT_TEXT_VERSION) and that version is stamped on every real subscriber record, so the
    // product can answer "which wording did this person agree to?". A retyped copy on the home
    // page is a copy that can drift from the version stamped on live consent rows — which is
    // precisely the failure the versioning exists to prevent. Asserting the CONSTANTS rather
    // than the strings is what makes "reuse, don't restate" mechanical instead of remembered.
    const text = textOf(await renderHome());
    expect(CARRIER_DISCLOSURES.length).toBeGreaterThan(0);
    for (const line of CARRIER_DISCLOSURES) {
      expect(text, 'rendered from lib/sms/consent-copy.ts, never retyped').toContain(line);
    }
  });

  it('🔴 H11 — the sender identity is stated and the support number is a real tel: link', async () => {
    // CASL identification. The number must stay tappable: a parent reads this on the phone they
    // are about to sign up with. Flattened into prose it is just characters.
    const html = await renderHome();
    const text = textOf(html);
    expect(text).toContain(SENDER_IDENTITY.legalName);
    expect(text).toContain(SENDER_IDENTITY.operatingAs);
    expect(text).toContain(SENDER_IDENTITY.mailingAddress);
    expect(text).toContain(SUPPORT_LINE);
    expect(hrefs(html)).toContain(SUPPORT_PHONE_HREF);
  });

  it('🔴 H12 — privacy, terms and the coverage evidence page are each one step away', async () => {
    const found = hrefs(await renderHome());
    for (const route of ['/privacy', '/terms', '/coverage-status']) {
      expect(found, `${route} must be reachable from the home page`).toContain(route);
    }
  });

  it('the STOP instruction is in the first screen, not only in the terms block', async () => {
    // AC-13's sharpest element: a parent deciding whether to hand over a number should see how
    // to stop before they decide, not after they scroll.
    const html = await renderHome();
    const offer = html.slice(at(html, '<section class="kf-home__sms'), at(html, 'kf-home__proof'));
    expect(offer).toMatch(/STOP/);
  });
});

describe('AC-10 / T3.3 — the page describes the offer, not the activity guide', () => {
  it('🔴 H13 — title and description both state what the SMS product is', () => {
    const title = String(metadata.title);
    const description = String(metadata.description);
    // What it is, where, and what it costs — the same questions the first screen answers, so the
    // search snippet and the page agree instead of promising a directory and delivering a signup.
    expect(title.toLowerCase()).toContain('text');
    expect(title).toContain('Metro Vancouver');
    expect(description.toLowerCase()).toContain('text a week');
    expect(description).toContain('Metro Vancouver');
    // The description this replaced. Pinned by its distinctive phrase so a revert is caught.
    expect(description).not.toContain('field guide');
    expect(title).not.toContain('What’s on for your kids');
  });
});

describe('T2.6 — the proof block reads as the weekly text, and is non-interactive (G1, Q1)', () => {
  // RENDERED FOR REAL, not through the stub at the top of this file: the two things asserted
  // here are properties of the component's own markup, and a stub would prove neither.
  it('🔴 H8 / H9 — framed as a sample of the text, with zero anchors inside the thread', async () => {
    const element = (await ThreeThings()) as ReactElement | null;
    // The block returns null only when the search engine could not be loaded at all. If that
    // happens here the assertions below would be vacuous, so say so rather than pass.
    expect(element, 'the fixture search engine must load for this assertion to mean anything').not.toBeNull();
    const html = renderToStaticMarkup(element!);

    // H8 — THE FRAMING IS LOAD-BEARING, NOT COSMETIC (TSD §6.3). Three activity cards are
    // visually substantial: headed "browse some activities" they read as search content and
    // spend the entire 10% budget on their own; headed as a sample of the weekly text they are
    // SMS proof and sit inside the 90%. The same component, either side of the ratio.
    const text = textOf(html);
    expect(text).toContain('A sample of what your weekly text looks like');
    expect(text).not.toContain('Three things you could do today');

    // H9 — NON-INTERACTIVE, LOCKED AT GATE G1 (Operator ruling, Q1). No card anchors, no
    // per-slot escape links, no "see everything on today" footer into /search. A link here is
    // both a broken promise about what this block is AND search weight inside the 90%.
    expect(html.match(/<a\s/g) ?? []).toHaveLength(0);
    expect(hrefs(html)).toEqual([]);
    // …and it is a rendered thread rather than a grid of cards, which is what makes the absence
    // of an affordance read as intentional rather than broken.
    expect(html).toContain('kf-home__msg');
    expect(html).toContain('kf-home__pick');
  });
});
