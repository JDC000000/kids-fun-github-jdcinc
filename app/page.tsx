import Link from 'next/link';
import './_components/home.css';
import { Button, Input } from '@/components/ui';
import {
  QUICK_START_FILTERS,
  destinationHref,
  liveCategoryDestinations,
} from './_lib/nav-destinations';
import { ThreeThings } from './_components/ThreeThings';
import { ChildProfilePrompt } from './_components/ChildProfilePrompt';
import { smsSignupAvailability } from '@/lib/sms/availability';

// Home / front door (M3 Screen 1, Visual Blueprint v0.2). The first thing a
// first-time parent sees: it introduces KIDS FUN in the civic field-guide voice,
// gives one prominent way to search, and routes into the real product surfaces —
// /search (the scan page) and /preview/[id] (detail). It is deliberately NOT a
// second results page: it is the entry point that ties the built surfaces together.
//
// Server component. The one client island left is the ask-once child-profile prompt, which
// degrades to nothing (storage unavailable / already answered) so the front door is complete
// without it.

/**
 * PER-REQUEST RENDER, and this is the architectural consequence of the whole feature.
 *
 * This page was statically prerendered: no `dynamic`, no `fetch`, no `headers()` — HTML built
 * once and served with no data access. `<ThreeThings />` evaluates a real search in process, so
 * the page has to be rendered per request, exactly as /search already declares itself
 * (app/search/page.tsx). The Operator ruled on the alternative and the reasoning is worth keeping
 * next to the line it justifies: "the whole feature's premise is 'the answer is already there
 * when you arrive' and a client-hydrated version would defeat that". A static page whose answer
 * arrives after hydration is not an answer before search; it is the old strip with a new name.
 *
 * WHAT IT COSTS, MEASURED RATHER THAN ASSUMED (docs/answer-before-search-measurements.md). The
 * expensive half of a search — the catalogue load — is already cached per warm instance
 * (lib/search/postgres-repository.ts `getCachedPostgresListings`), and this page's three slot
 * queries are in-memory passes over that same warm set, sharing it with /search rather than
 * adding a second read model. It is a real cost on a cold instance and a small one when warm.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'KIDS FUN — What’s on for your kids across Metro Vancouver',
  description:
    'A civic field guide to real kids’ activities across Metro Vancouver — the source and last-checked date on every listing, so you can trust it before you go.',
};

/**
 * Category entry points — the SAME list the global nav renders (app/_lib/nav-destinations.ts).
 *
 * These were two hand-maintained copies until this change, and they had already drifted:
 * different labels for the same query, two encodings of the same URL, and a "Festivals" tile
 * the nav had already dropped as dead. The list now decides labels, captions, glyphs, hrefs
 * and which destinations are offered at all, once, for both surfaces. Deliberately NO
 * open_gym / skate / nature tiles — those categories have no real listings on the live
 * sources today.
 */
const CATEGORIES = liveCategoryDestinations();

export default function Home() {
  /*
   * ═══ THE FAIL-SAFE, EVALUATED PER REQUEST (AC-12) ═══
   * SMS_SIGNUP_ENABLED defaults to FALSE and app/sms/start/page.tsx calls `notFound()` unless it
   * is exactly 'true'. So the DEFAULT state of this product is a signup page that 404s, and a
   * front door that advertised it unconditionally would not be "usually right" — it would be
   * wrong by default and right only while an environment variable happened to be set.
   *
   * Asked HERE rather than inside the offer component so the branch is visible on the page that
   * owns the decision, and asked through lib/sms/availability.ts rather than process.env so this
   * file never learns which variable governs signup.
   *
   * `force-dynamic` above is what makes this cheap and correct at the same time: the page already
   * re-renders per request for <ThreeThings />, so the flag is re-read every time and flipping it
   * takes effect WITHOUT A REBUILD. On a statically prerendered page this check would have been
   * baked in at build time and would have lied for as long as the deployment lived.
   */
  const signup = smsSignupAvailability();

  return (
    <div className="kf">
      <div className="kf-page">
        <div className="kf-app">
          {/* ── Hero (evergreen anchor) with the primary search control embedded ── */}
          <header className="kf-hero kf-home__hero">
            <p className="kf-hero__wordmark">KIDS FUN</p>
            <h1 className="kf-hero__title">See what&apos;s on for your kids today.</h1>
            <p className="kf-hero__sub">
              A field guide to real kids&apos; activities across Metro Vancouver — with the source and last-checked
              date on every listing, so you can trust it before you go.
            </p>

            <form className="kf-home__search" action="/search" method="get" role="search">
              <label className="kf-home__search-label" htmlFor="kf-home-q">
                What are you looking for?
              </label>
              <div className="kf-home__search-row">
                {/* Canonical primitives (components/ui) proving the design-token
                    foundation on the app's most-shared, lowest-risk surface. */}
                <Input
                  id="kf-home-q"
                  className="kf-home__search-input"
                  type="search"
                  name="q"
                  placeholder="family swim, storytime, soft play…"
                  autoComplete="off"
                  enterKeyHint="search"
                  aria-label="Search kids' activities across Metro Vancouver"
                />
                <Button type="submit" variant="primary" className="kf-home__search-btn">
                  Search
                </Button>
              </div>
            </form>
          </header>

          <main className="kf-home__main">
            {/* ── The SMS offer (TSD §9 M1 / Deltas 1-2). ───────────────────────────────────
                PLACEMENT AND COPY ARE PROVISIONAL AND OWNED BY M2, not by this block: the home
                page rebuild moves the offer into the hero and confirms the wording at G2. What
                is NOT provisional is the branch — the mechanism below is the fail-safe itself,
                and M2 changes where this renders without changing whether it may render.

                TWO BRANCHES, AND THE UNAVAILABLE ONE IS A SENTENCE RATHER THAN NOTHING. Removing
                the block entirely would read as a layout bug to the next person to open the page
                and would tell a parent nothing about a thing that genuinely exists and is nearly
                ready. Removing only the ACTION is the actual requirement, and it is what the
                absence of `signup.href` in that branch enforces — there is no path to link to,
                so there is nothing to accidentally render as a button. ── */}
            {signup.available ? (
              <section className="kf-home__sms" aria-labelledby="kf-home-sms">
                <h2 className="kf-home__sms-title" id="kf-home-sms">
                  Get one text a week
                </h2>
                <p className="kf-home__sms-sub">
                  Things to do with your kids across Metro Vancouver, sent to your phone once a
                  week. No app, no account.
                </p>
                <Link className="kf-home__sms-cta" href={signup.href}>
                  Get the weekly text
                </Link>
              </section>
            ) : (
              <section
                className="kf-home__sms kf-home__sms--unavailable"
                aria-labelledby="kf-home-sms"
              >
                <h2 className="kf-home__sms-title" id="kf-home-sms">
                  One text a week, soon
                </h2>
                <p className="kf-home__sms-sub">
                  We&apos;re getting ready to send one text a week with things to do with your
                  kids across Metro Vancouver. It isn&apos;t open for sign-ups yet.
                </p>
              </section>
            )}

            {/* ── Ask once: "who are you looking for" (U1). The HOME PAGE ONLY, by ruling
                (design §9-Q7). Renders nothing once answered, once dismissed for the session,
                or when storage is unavailable — so it is a first-visit question, not chrome. ── */}
            <ChildProfilePrompt />

            {/* ── The answer, before any search (Track A, Jon's rulings 2026-08-19). Server
                rendered, above the category tiles per ruling 7.1, and it does NOT hide itself
                when a slot is empty — it says so. Replaces the old client-side taste strip. ── */}
            <ThreeThings />

            {/* ── Browse by activity — category tiles into real /search results ── */}
            <section className="kf-home__section" aria-labelledby="kf-home-browse">
              <div className="kf-section__head">
                <h2 className="kf-section__title" id="kf-home-browse">
                  Browse by activity
                </h2>
                <span className="kf-section__rule" aria-hidden="true" />
              </div>
              <p className="kf-home__note">
                Every tile opens live, source-checked listings — not a marketing page.
              </p>
              <ul className="kf-home__tiles">
                {CATEGORIES.map((c) => (
                  <li key={c.key}>
                    <Link className="kf-home__tile" href={destinationHref(c)}>
                      <span className="kf-home__tile-text">
                        <span className="kf-home__tile-label">{c.label}</span>
                        <span className="kf-home__tile-caption">{c.caption}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>

            {/* ── Quick starts — CONSTRAINTS, not a second copy of the categories (D5).
                The tiles above answer "where do I want to go"; this row answers "what am I
                stuck with". It used to hold three chips, two of which were byte-identical
                to global-nav links ("Free things to do" → /search?free=1, "Browse everything
                on now" → /search) — a worse duplicate of navigation that already exists on
                every page. Those are gone; what is left is the row's actual job. ── */}
            <section className="kf-home__section" aria-labelledby="kf-home-quick">
              <div className="kf-section__head">
                <h2 className="kf-section__title" id="kf-home-quick">
                  Quick starts
                </h2>
                <span className="kf-section__rule" aria-hidden="true" />
              </div>
              <p className="kf-home__note">
                Narrow any search in one tap — these change what you get back, they don&apos;t pick an
                activity.
              </p>
              <div className="kf-home__quick" role="list">
                {QUICK_START_FILTERS.map((f) => (
                  <Link key={f.key} className="kf-home__quick-chip" href={f.href} role="listitem">
                    {f.label}
                  </Link>
                ))}
              </div>
            </section>

            {/* ── One line of evidence, not three of assertion.
                This was a three-card "How KIDS FUN works" section, and each card was a claim
                about ourselves with nothing behind it. Two of the three were already stated
                elsewhere on their own merits — the hero says every listing carries its source
                and last-checked date, and the "confirmed vs expected" split is visible on
                /search where the sections actually are. What was missing was the checkable
                part: /coverage-status has been live and linked from NOWHERE. A parent can now
                go and read what we cover instead of reading that we are trustworthy. ── */}
            <p className="kf-home__evidence">
              We only list activities from sources with confirmed permission.{' '}
              <Link className="kf-home__evidence-link" href="/coverage-status">
                See which areas we cover, and when each was last checked
              </Link>
              .
            </p>
          </main>
        </div>
      </div>
    </div>
  );
}
