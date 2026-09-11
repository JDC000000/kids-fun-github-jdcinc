import Link from 'next/link';
import './not-found.css';
import { Button, Input } from '@/components/ui';
import {
  SEARCH_SHORTCUTS,
  destinationHref,
  liveCategoryDestinations,
} from './_lib/nav-destinations';

/**
 * app/not-found.tsx — the branded 404.
 *
 * ═══ WHAT IT REPLACES ═══
 * Nothing in this repo handled an unmatched URL, so every mistyped address, every stale
 * bookmark and every `notFound()` in the app fell through to Next.js's built-in page: the
 * words "404 | This page could not be found." in Times-adjacent system type, on white, with
 * no navigation and no link anywhere. A parent who mistyped `/serach` had no route back into
 * the product except the browser's back button — the same dead-end failure the
 * /activity-unavailable interstitial was written to avoid for cancelled sessions, and for
 * the same reason: a bare 404 does not read as "wrong address", it reads as "this product is
 * broken".
 *
 * ═══ WHY IT CARRIES ITS OWN WAY OUT INSTEAD OF LEANING ON THE GLOBAL NAV ═══
 * SiteNav and SiteFooter DO render around this page on most paths, and on those paths this
 * page's own links are a second route to the same places. That redundancy is deliberate,
 * because there are two live cases where the chrome is not there to lean on:
 *   • `BARE_CHROME_PREFIXES` (lib/sms/surfaces.ts) strips all chrome under `/u`, `/sms/start`
 *     and `/sms/signup`. A mistyped preferences link — `/u/<token-with-a-character-dropped>`
 *     is exactly the kind of URL that arrives by copy-paste out of a text message — lands
 *     here with no nav and no footer at all.
 *   • Unmatched URLs are served from the statically-generated `/_not-found` output, so the
 *     chrome components' `usePathname()` gate resolves against the REAL path only after
 *     hydration. A parent with JavaScript still loading sees whatever the static render
 *     decided.
 * A 404 whose only exit is a component that is sometimes absent is still a dead end some of
 * the time. This one is self-sufficient.
 *
 * ═══ NO HERO BAND ═══
 * The obvious move — reuse the home page's `.kf-hero` — is the exact thing audit Quick Win #7
 * deleted from /search: a band that restates the product's pitch to somebody who has already
 * arrived, above the content they actually came for. The lesson generalises to this page, and
 * arguably harder: a parent who has just hit a wrong address wants the way out, not the
 * value proposition. The wordmark they would have read off a hero is already in the nav.
 *
 * ═══ THE ONWARD LINKS ARE THE SHARED VOCABULARY, NOT A THIRD HAND-MAINTAINED LIST ═══
 * `app/_lib/nav-destinations.ts` exists because SiteNav and the home page kept two copies of
 * the same destinations and they drifted — different labels, different encodings of the same
 * URL, and one dead category that only one surface had dropped. Hard-coding "Swimming,
 * Storytime, Indoor play…" here would have recreated that bug on a third surface, and this is
 * the one surface where a link that quietly goes nowhere is least excusable. Reading the
 * shared list means a retired destination disappears from this page too, and
 * tests/nav-destinations.test.tsx's real-search check covers these links as well.
 */

/**
 * A 404 is served with a 404 status, which is the authoritative signal to a crawler — so this
 * needs no `robots` directive of its own. The title is here for the HUMAN case: a parent with
 * six tabs open should be able to tell from the tab strip which one went wrong, and the root
 * layout's bare "KIDS FUN" does not tell them.
 */
export const metadata = {
  title: 'Page not found — KIDS FUN',
};

/** The same live set the nav and the home tiles render — never a local copy. See above. */
const CATEGORIES = liveCategoryDestinations();

export default function NotFound() {
  return (
    <div className="kf">
      <div className="kf-page">
        <div className="kf-app">
          <main className="kf-nf">
            {/* Glyph → eyebrow → title → body is the shape /search's own empty state already
                uses (`.kf-empty` in app/search/search.css), so "there is nothing at this
                address" looks like the product's existing way of saying "there is nothing
                here" rather than a new visual idea. The classes are a deliberate MIRROR and
                not an import: search.css is a 50KB route stylesheet full of filter-rail and
                results chrome, and pulling it onto the 404 to borrow four rules would ship
                all of it to a page that has no filters and no results. */}
            <div className="kf-nf__glyph" aria-hidden="true">
              ◍
            </div>
            <p className="kf-nf__eyebrow">Page not found</p>
            <h1 className="kf-nf__title">That page isn&rsquo;t here.</h1>
            <p className="kf-nf__body">
              The address may have a typo in it, or the link may be older than the page it pointed at. The
              catalogue itself is fine &mdash; pick it up again from here.
            </p>

            {/* A real GET form to /search, identical in mechanism to the home page's and
                /search's own: no client JavaScript, so it works on the statically-served
                `/_not-found` output before anything hydrates. That matters more here than
                anywhere else in the product — this page's whole job is to work when
                something else already did not. */}
            <section className="kf-nf__section" aria-labelledby="kf-nf-search-h">
              <h2 className="kf-nf__section-title" id="kf-nf-search-h">
                Search for something instead
              </h2>
              <form className="kf-nf__search" action="/search" method="get" role="search">
                {/* NO `aria-label` ON THE INPUT, deliberately — and the two sibling search forms
                    (app/page.tsx, SearchBar.tsx) both have one. An aria-label OVERRIDES the
                    associated <label> in the accessible-name computation, so those fields are
                    announced as "Search kids' activities across Metro Vancouver" while the words
                    printed beside them say "What are you looking for?". That is a WCAG 2.5.3
                    (Label in Name) mismatch and it breaks voice control outright: "click what are
                    you looking for" matches nothing. The visible label IS the accessible name
                    here; `role="search"` on the form supplies the context the aria-label was
                    reaching for. (The other two are pre-existing and out of this change's scope —
                    noted so the difference reads as a decision, not an omission.) */}
                <label className="kf-nf__search-label" htmlFor="kf-nf-q">
                  What are you looking for?
                </label>
                <div className="kf-nf__search-row">
                  <Input
                    id="kf-nf-q"
                    className="kf-nf__search-input"
                    type="search"
                    name="q"
                    placeholder="family swim, storytime, soft play&hellip;"
                    autoComplete="off"
                    enterKeyHint="search"
                  />
                  <Button type="submit" variant="primary" className="kf-nf__search-btn">
                    Search
                  </Button>
                </div>
              </form>
            </section>

            <section className="kf-nf__section" aria-labelledby="kf-nf-browse-h">
              <h2 className="kf-nf__section-title" id="kf-nf-browse-h">
                Or start from one of these
              </h2>
              <ul className="kf-nf__links">
                {/* "What's on now" first: it is the one destination that is a PLACE rather
                    than a query, and it is the closest thing the product has to "show me
                    everything" — the right default for somebody who has lost their bearings. */}
                <li>
                  <Link className="kf-nf__link" href={SEARCH_SHORTCUTS.onNow.href}>
                    {SEARCH_SHORTCUTS.onNow.label}
                  </Link>
                </li>
                {CATEGORIES.map((c) => (
                  <li key={c.key}>
                    <Link className="kf-nf__link" href={destinationHref(c)}>
                      {c.label}
                    </Link>
                  </li>
                ))}
                <li>
                  <Link className="kf-nf__link" href={SEARCH_SHORTCUTS.free.href}>
                    {SEARCH_SHORTCUTS.free.label}
                  </Link>
                </li>
              </ul>
            </section>

            <p className="kf-nf__home">
              <Link href="/">Back to the KIDS FUN home page</Link>
            </p>
          </main>
        </div>
      </div>
    </div>
  );
}
