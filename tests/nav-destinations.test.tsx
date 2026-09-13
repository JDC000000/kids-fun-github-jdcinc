// tests/nav-destinations.test.tsx — the safety net under app/_lib/nav-destinations.ts.
//
// The shared destination list exists because two hand-maintained copies had already drifted
// (different labels for the same query, `+` vs `%20` encodings of the same URL, a dead
// "Festivals" tile the nav had already dropped). Sharing the list stops the two surfaces
// disagreeing with EACH OTHER. It does nothing at all to stop the list disagreeing with
// REALITY — a `status: 'live'` flag on a query that returns nothing is exactly as broken as
// the two lists were, just harder to notice. That is what the first block below is for: it
// runs a REAL search for every entry, through the real /api/search route, and fails if the
// flag and the engine disagree in either direction.
//
// ═══ T3.4 — THE MUTATION MATRIX (standing F-4 lesson) ═══
// The nav contract changed by design, so these assertions were REWRITTEN rather than relaxed —
// and a rewritten assertion is exactly the kind that can come back weaker than it went in. Every
// new guard below was therefore mutation-tested: the regression applied to the real source, the
// suite run, the source restored. All seven turned this lane red.
//
//  #   guard                                                     mutation that kills it
//  N1  the SMS entry LEADS the bar, not merely appears in it     move it to the end of LINKS
//  N2  the nav points at /sms/start, never the /sms/signup 308   swap the href for the redirect
//  N3  the wide row and the compact menu cannot drift apart      render LINKS.slice(1) in the row
//  N4  the SMS marker renders on BOTH surfaces, one renderer     drop the --sms class
//  N5  the marker is WEIGHT, not its Leaf dot alone (WCAG 1.4.1) set font-weight back to 400
//  N6  the entry is DROPPED when signup is unavailable (AC-12)  default smsSignupHref to the path
//  N7  …and the bar degrades to the search list, not to nothing return [] from navLinks()
//
// 🔴 N6 EARNED THE PASS. The first cut of T3.1 built the SMS entry at module scope from
// SMS_SIGNUP_PATH, unconditionally. Every assertion in both nav files was green, because none of
// them knew the flag existed — and tests/home/sms-offer.test.tsx renders <Home /> alone, so the
// nav was outside its AC-12 sweep too. Loading the BUILT page with SMS_SIGNUP_ENABLED=false still
// returned `href="/sms/start"`, from the bar, on the one page whose entire fail-safe branch exists
// to prevent exactly that. The guard is here because the gap was between two files, not inside one.
//
// WHICH ENGINE THIS ACTUALLY MEASURES, STATED PLAINLY
// With KIDS_FUN_SEARCH_BACKEND unset (the default, and what CI runs) the route serves the
// FIXTURE catalogue, not the staging database. So this file proves the flags against the
// catalogue CI can reach, which is a real search — parser, filters, ranking, the lot — over a
// hand-authored dataset. Where that dataset has no row of a given kind, the check cannot
// speak; see FIXTURE_BLIND_SPOTS, which names those cases explicitly rather than letting them
// pass quietly, and which is itself asserted so it cannot silently widen.
import { describe, expect, it, vi, afterAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

// SiteNav reads usePathname, and the home page's ChildProfilePrompt island reads useRouter.
// Neither has an app-router context under renderToStaticMarkup; both are irrelevant to what
// this file asserts, so they are stubbed rather than staged.
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// The home page's "three things" block is an ASYNC server component (it awaits the search
// engine), and `renderToStaticMarkup` is the legacy synchronous renderer — handed a promise for
// a child it throws "Objects are not valid as a React child", which takes the whole FILE down
// rather than one test. Stubbed to a marker so this file can go on rendering <Home /> for the
// only thing it is about: which destination links the page emits.
//
// NOT A CONVENIENT SILENCE. Stubbing it would hide a real collision if the block's own links
// overlapped the shared destination list, so the thing the stub costs is asserted directly
// instead — see "the three-things block does not smuggle a second copy of a nav destination"
// at the end of this file, which reads the block's real hrefs rather than a rendering of them.
vi.mock('../app/_components/ThreeThings', () => ({
  ThreeThings: () => <div data-testid="three-things-stub" />,
}));

const { GET } = await import('../app/api/search/route');
const { FIXTURE_NOW } = await import('../lib/search/__fixtures__/engine');
const { CATEGORY_DESTINATIONS, QUICK_START_FILTERS, SEARCH_SHORTCUTS, destinationHref, liveCategoryDestinations } =
  await import('../app/_lib/nav-destinations');
const { SMS_SIGNUP_PATH } = await import('../lib/sms/config');
const { SiteNav } = await import('../app/_components/SiteNav');
const { SiteFooter } = await import('../app/_components/SiteFooter');
const { default: Home } = await import('../app/page');
// The block's own link table, imported rather than restated — see the last test in this file.
const { SLOT_HREF, HOME_TODAY_HREF } = await import('../app/_components/three-things-links');

/**
 * Destinations that are `live` in the product but have NO row of their kind in the fixture
 * catalogue, so the CI engine cannot prove them non-empty either way.
 *
 * MEASURED, not assumed: lib/search/__fixtures__/listings.ts carries open_gym, public_swim,
 * skate, storytime, indoor_play, miniature_train, aquarium and tobogganing rows — and no
 * class_program row at all. "Classes" is therefore empty here for a fixture-coverage reason,
 * not a product reason (it returned 34 class_program listings against the staging database on
 * 2026-07-14). Flagging it `retired` on that basis would be the drift this file exists to stop.
 *
 * This is NOT a blanket escape hatch: an entry listed here is asserted to return ZERO. Add a
 * class_program fixture and this test fails, telling you to delete the entry and let the real
 * assertion take over. It can only ever shrink by accident, never grow.
 */
const FIXTURE_BLIND_SPOTS = new Set(['classes']);

/** The exact query string a surface would navigate to, plus the flags that make a count honest:
 *  `minResults=0` disables the broadening ladder (which can rescue a genuine zero into a
 *  non-zero and would make a dead destination look alive), and a high `limit` keeps a live one
 *  from being confused with a truncated one. */
async function resultCount(hrefQuery: string): Promise<number> {
  const res = await GET(new Request(`http://localhost/api/search?${hrefQuery}&minResults=0&limit=100`));
  const body = (await res.json()) as { results?: unknown[]; meta?: { backend?: string } };
  expect(res.status).toBe(200);
  return body.results?.length ?? 0;
}

function hrefsIn(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

describe('nav destinations agree with the search engine', () => {
  // Fixture listings are dated July 2026 and the route has no `now` param — it reads the wall
  // clock. Unpinned, every count here would be a function of the day the suite happens to run.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXTURE_NOW);
  afterAll(() => {
    vi.useRealTimers();
  });

  it.each(CATEGORY_DESTINATIONS.filter((d) => d.status === 'retired').map((d) => [d.key, d] as const))(
    'retired destination %s returns nothing (if it starts returning results, un-retire it)',
    async (_key, destination) => {
      const count = await resultCount(destinationHref(destination).split('?')[1]);
      expect(count).toBe(0);
    },
  );

  it.each(
    CATEGORY_DESTINATIONS.filter((d) => d.status === 'live' && !FIXTURE_BLIND_SPOTS.has(d.key)).map(
      (d) => [d.key, d] as const,
    ),
  )('live destination %s returns real results (if it stops, stop offering it)', async (_key, destination) => {
    const count = await resultCount(destinationHref(destination).split('?')[1]);
    expect(count).toBeGreaterThan(0);
  });

  it.each([...FIXTURE_BLIND_SPOTS].map((key) => [key] as const))(
    'blind spot %s is still genuinely unrepresented in the fixture catalogue',
    async (key) => {
      const destination = CATEGORY_DESTINATIONS.find((d) => d.key === key);
      expect(destination, `FIXTURE_BLIND_SPOTS names "${key}", which is not a destination`).toBeDefined();
      const count = await resultCount(destinationHref(destination!).split('?')[1]);
      expect(
        count,
        `"${key}" now returns results in fixtures — delete it from FIXTURE_BLIND_SPOTS so the real assertion covers it`,
      ).toBe(0);
    },
  );

  it.each(QUICK_START_FILTERS.map((f) => [f.key, f] as const))(
    'quick-start filter %s narrows to a non-empty result set',
    async (_key, filter) => {
      expect(await resultCount(filter.href.split('?')[1] ?? '')).toBeGreaterThan(0);
    },
  );
});

// <Home /> became an ASYNC server component when it started emitting `sms_offer_viewed` during
// render (TSD §9 M1 T1.5), exactly as /search already was. renderToStaticMarkup is the legacy
// synchronous renderer, so the component is invoked and AWAITED and its element tree handed
// over — the same accommodation this file already makes for the async <ThreeThings /> above,
// and cheaper than stubbing out a page this file exists to render. It sits at MODULE scope
// because a `describe` callback may not be async (esbuild rejects the await outright), and this
// file already uses top-level await for its imports.
const HOME_HTML = renderToStaticMarkup((await Home()) as ReactElement);

describe('every surface renders the one shared list', () => {
  const navHtml = renderToStaticMarkup(<SiteNav smsSignupHref={SMS_SIGNUP_PATH} />);
  const homeHtml = HOME_HTML;
  const footerHtml = renderToStaticMarkup(<SiteFooter />);
  const live = liveCategoryDestinations();
  const retired = CATEGORY_DESTINATIONS.filter((d) => d.status === 'retired');

  /**
   * ═══ THE NAV CONTRACT, AFTER THE SMS FRONT-DOOR REBUILD (TSD v1.2 T3.1 / T3.4) ═══
   *
   * The bar used to be "what's on now + the live categories + free". It now LEADS WITH THE SMS
   * OFFER and keeps that whole run behind it. Both halves of that sentence are asserted, and
   * neither was weakened to make the suite pass:
   *
   *   · the SMS entry is FIRST, not merely present — the ordering IS the requirement. A nav that
   *     carried the offer last would satisfy "renders the SMS offer" and defeat the point.
   *   · the category run is unchanged, in its original order, still read from the shared list.
   *
   * DERIVED FROM THE SOURCES, NEVER TYPED OUT. A literal array of seven strings here would pass
   * while the shared list said something else, which is the exact drift this file exists to
   * catch. `SMS_SIGNUP_PATH` is imported from lib/sms/config for the same reason — it is the one
   * constant `signupUrl()` composes from and lib/sms/availability.ts hands the home page, so a
   * nav link written by hand could disagree with the product's own idea of where signup lives.
   */
  const NAV_HREFS = [
    SMS_SIGNUP_PATH,
    SEARCH_SHORTCUTS.onNow.href,
    ...live.map(destinationHref),
    SEARCH_SHORTCUTS.free.href,
  ];

  it('has at least one retired destination to exclude, so the exclusion tests are not vacuous', () => {
    // The `DEAD_CATEGORY` constant this replaced filtered an href that was never in the list,
    // i.e. it was a no-op dressed as a safeguard. This assertion is what stops the same thing
    // happening here: if nothing is retired, the two "renders nowhere" tests below prove nothing.
    expect(retired.length).toBeGreaterThan(0);
    expect(live.length).toBeGreaterThan(0);
  });

  it('SiteNav renders exactly the SMS offer + what is on now + the live categories + free, in that order', () => {
    // '/' is the wordmark link, which is not a destination.
    expect(hrefsIn(navHtml).filter((h) => h !== '/')).toEqual([...NAV_HREFS, ...NAV_HREFS]);
  });

  it('🔴 the SMS offer LEADS the bar — being present is not the requirement', () => {
    // T3.1 is an ORDERING change as much as an addition: "reordered so the SMS offer leads".
    // Asserted separately from the list comparison above so that a future edit which moves it
    // to the end fails HERE, with a message that says what the rule is, rather than as an
    // opaque array diff.
    expect(NAV_HREFS[0]).toBe(SMS_SIGNUP_PATH);
    const rendered = hrefsIn(navHtml).filter((h) => h !== '/');
    expect(rendered[0]).toBe(SMS_SIGNUP_PATH);
    expect(rendered.indexOf(SEARCH_SHORTCUTS.onNow.href)).toBeGreaterThan(0);
  });

  it('🔴 AC-12 — with signup unavailable the bar drops the entry rather than linking to a 404', () => {
    // `SMS_SIGNUP_ENABLED` defaults to FALSE and /sms/start `notFound()`s unless it is exactly
    // 'true', so an unconditional entry would be a link to a 404 on EVERY chromed page in the
    // state the product spends most of its life in — including the home page, whose whole
    // fail-safe branch exists to prevent that. Caught by loading the built page with the flag
    // off: the M1 unit test renders <Home /> alone, so the nav sat outside every assertion.
    const degraded = renderToStaticMarkup(<SiteNav smsSignupHref={null} />);
    expect(hrefsIn(degraded)).not.toContain(SMS_SIGNUP_PATH);
    expect(degraded).not.toContain('kf-nav__link--sms');
    expect(textOf(degraded)).not.toContain('Get the weekly text');
    // …and it degrades to the bar the product had before, not to nothing: every search
    // destination is still there, in order, on both surfaces.
    expect(hrefsIn(degraded).filter((h) => h !== '/')).toEqual([
      ...NAV_HREFS.slice(1),
      ...NAV_HREFS.slice(1),
    ]);
  });

  it('🔴 the nav points at the reachable signup path, never the 308', () => {
    // /sms/signup is a permanent redirect to /sms/start (next.config.mjs). A nav link routed
    // through it would spend a redirect hop on every tap, and would read as a second signup
    // page to anyone auditing the funnel. The redirect stays (already-printed QR codes depend
    // on it, AC-08b) — nothing in the product's own navigation may use it.
    expect(SMS_SIGNUP_PATH).toBe('/sms/start');
    expect(hrefsIn(navHtml)).not.toContain('/sms/signup');
  });

  it('🔴 the bar is the SMS offer plus the WHOLE shared list, with nothing dropped to make room', () => {
    // Length derived from the sources, not a magic 7: the three fixed entries (the SMS offer,
    // "What's on now", "Free") plus every live category. Adding a category must widen this
    // automatically, and quietly dropping one to fit the new entry must fail.
    expect(NAV_HREFS).toHaveLength(3 + live.length);
    expect(new Set(NAV_HREFS).size).toBe(NAV_HREFS.length); // no entry listed twice
  });

  // ═══ SiteNav EMITS THE LIST TWICE, AND THAT IS THE POINT OF THIS TEST ═══
  // Below 768px the inline row is replaced by a compact <details> menu, because six pills
  // need ~456px and a 390px phone can only show ~200px of them — four destinations were
  // simply off the end. The row and the menu are BOTH in the HTML; site-nav.css displays
  // exactly one of them per breakpoint, so a visitor and a screen reader still see one copy.
  //
  // The assertion above therefore expects the list twice, which on its own would be a weaker
  // test than the one it replaced: `[...expected, ...expected]` also matches a nav that
  // rendered the row twice and no menu. So each container is checked SEPARATELY here, which
  // is strictly stronger than the single flat comparison ever was — it pins the order, the
  // encoding AND the retired-exclusion independently on both surfaces, which is the same
  // drift this file exists to catch, now applied within one component instead of between two.
  describe('the wide row and the compact menu cannot drift apart', () => {
    /** Contents of a specific <ul> in the rendered nav. The two lists are siblings, never
     *  nested, so a non-greedy slice to the next </ul> is exact. */
    const listNamed = (cls: string): string => {
      const m = navHtml.match(new RegExp(`<ul class="${cls}">(.*?)</ul>`, 's'));
      if (!m) throw new Error(`SiteNav no longer renders <ul class="${cls}">`);
      return m[1];
    };
    it('the ≥768px inline row carries the whole list, in order', () => {
      expect(hrefsIn(listNamed('kf-nav__list'))).toEqual(NAV_HREFS);
    });

    it('the <768px compact menu carries the whole list, in the same order', () => {
      expect(hrefsIn(listNamed('kf-nav__menu'))).toEqual(NAV_HREFS);
    });

    it('🔴 the two containers are byte-identical to each other, not merely each correct', () => {
      // Strictly stronger than the two assertions above, and it survives a future change to
      // NAV_HREFS itself: whatever the bar decides to carry, the phone must get the same thing.
      expect(hrefsIn(listNamed('kf-nav__menu'))).toEqual(hrefsIn(listNamed('kf-nav__list')));
    });

    it('🔴 the SMS entry is marked on BOTH surfaces, from the one renderer', () => {
      // SiteNav renders the row and the menu through a single `renderLink`, which is what stops
      // them drifting. A marker that appeared on only one of them would mean a second renderer
      // had been introduced — the drift itself, wearing a class name.
      expect(listNamed('kf-nav__list')).toContain('kf-nav__link--sms');
      expect(listNamed('kf-nav__menu')).toContain('kf-nav__link--sms');
      // …and it marks exactly one entry per surface, not the whole row.
      for (const cls of ['kf-nav__list', 'kf-nav__menu']) {
        expect(listNamed(cls).match(/kf-nav__link--sms/g)).toHaveLength(1);
      }
    });

    it('the menu opens without JavaScript — a native <details>/<summary>, not a button', () => {
      // The bar is server-rendered and works with scripting off (SiteNav's own header note).
      // A JS-toggled menu would quietly make six destinations unreachable in that mode.
      expect(navHtml).toMatch(/<details[^>]*class="kf-nav__more"/);
      expect(navHtml).toMatch(/<summary class="kf-nav__more-toggle"/);
    });
  });

  it('the home tile grid renders exactly the live categories, in the same order', () => {
    const tileHrefs = hrefsIn(homeHtml).filter((h) => h.startsWith('/search?q='));
    expect(tileHrefs).toEqual(live.map(destinationHref));
  });

  it('a retired destination renders on NO surface', () => {
    for (const destination of retired) {
      const href = destinationHref(destination);
      expect(hrefsIn(navHtml)).not.toContain(href);
      expect(hrefsIn(homeHtml)).not.toContain(href);
      expect(textOf(navHtml)).not.toContain(destination.label);
      expect(textOf(homeHtml)).not.toContain(destination.label);
    }
  });

  it('the nav and the home tiles use the SAME label and the SAME URL for each destination', () => {
    // The drift this replaced was exactly here: "Classes" vs "Classes & programs" for one
    // query, and `q=family+swim` vs `q=family%20swim` for another.
    const navText = textOf(navHtml);
    const homeText = textOf(homeHtml);
    for (const destination of live) {
      expect(navText).toContain(destination.label);
      expect(homeText).toContain(destination.label);
      expect(hrefsIn(navHtml)).toContain(destinationHref(destination));
      expect(hrefsIn(homeHtml)).toContain(destinationHref(destination));
    }
  });

  it('the home page no longer duplicates a global-nav link in its quick starts', () => {
    const quickHrefs = QUICK_START_FILTERS.map((f) => f.href);
    expect(quickHrefs).not.toContain(SEARCH_SHORTCUTS.free.href);
    expect(quickHrefs).not.toContain(SEARCH_SHORTCUTS.onNow.href);
    expect(quickHrefs.length).toBeGreaterThan(0);
  });

  it('keeps Free in the global nav and nowhere else on the home page', () => {
    expect(hrefsIn(navHtml)).toContain(SEARCH_SHORTCUTS.free.href);
    expect(hrefsIn(homeHtml)).not.toContain(SEARCH_SHORTCUTS.free.href);
  });

  it('routes to the coverage evidence page from the home page and from global chrome', () => {
    expect(hrefsIn(homeHtml)).toContain('/coverage-status');
    expect(hrefsIn(footerHtml)).toContain('/coverage-status');
  });

  it('drops the home page’s duplicate footer, leaving the global one', () => {
    expect(homeHtml).not.toContain('kf-home__footer');
    expect(footerHtml).toContain('kf-site-footer');
  });

  it('the three-things block does not smuggle a second copy of a nav destination', () => {
    // THE ASSERTION THE STUB AT THE TOP OF THIS FILE WOULD OTHERWISE HAVE COST.
    //
    // The block (app/_components/ThreeThings.tsx) emits its own /search links: one per slot, as
    // the escape hatch an empty slot offers, plus a "see everything on today". Track B's rule is
    // that the home page must not carry a byte-identical duplicate of a link the global nav
    // already gives every page — that is why "Free things to do" left the quick-start row.
    //
    // These are not that, and the difference is not cosmetic: every one of them is scoped to
    // TODAY, which is the whole subject of the block, and each belongs to the slot it sits in
    // rather than standing on its own as navigation. The nav's `/search?free=1` means "show me
    // free things"; the block's `/search?free=1&when=today` means "there is nothing free on
    // today — here is the rest of today". Asserted rather than argued, so that if a future edit
    // trims one of these back to the bare nav URL, this fails and the decision gets made again
    // on purpose.
    const slotHrefs = Object.values(SLOT_HREF);
    const navHrefs = Object.values(SEARCH_SHORTCUTS).map((s) => s.href);
    for (const href of [...slotHrefs, HOME_TODAY_HREF]) {
      expect(navHrefs).not.toContain(href);
      expect(href).toContain('when=today');
    }
    // …and the tile-grid assertion above filters on '/search?q=', so none of these may take that
    // shape either, or they would silently join the category grid's expected list.
    for (const href of slotHrefs) expect(href.startsWith('/search?q=')).toBe(false);
  });
});
