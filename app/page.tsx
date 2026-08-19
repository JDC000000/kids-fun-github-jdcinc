import Link from 'next/link';
import './_components/home.css';
import { Button, Input } from '@/components/ui';
import { CategoryTile } from './preview/_components/CategoryTile';
import {
  QUICK_START_FILTERS,
  destinationHref,
  liveCategoryDestinations,
} from './_lib/nav-destinations';
import { HomeTodayStrip } from './_components/HomeTodayStrip';
import { ChildProfilePrompt } from './_components/ChildProfilePrompt';

// Home / front door (M3 Screen 1, Visual Blueprint v0.2). The first thing a
// first-time parent sees: it introduces KIDS FUN in the civic field-guide voice,
// gives one prominent way to search, and routes into the real product surfaces —
// /search (the scan page) and /preview/[id] (detail). It is deliberately NOT a
// second results page: it is the entry point that ties the built surfaces together.
//
// Server component: static, zero-JS to first paint, fast. The client islands are the
// small "on now" taste strip and the ask-once child-profile prompt — both degrade to
// nothing (no data / storage unavailable / already answered) so the front door is
// always complete without either of them.

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
            {/* ── Ask once: "who are you looking for" (U1). The HOME PAGE ONLY, by ruling
                (design §9-Q7). Renders nothing once answered, once dismissed for the session,
                or when storage is unavailable — so it is a first-visit question, not chrome. ── */}
            <ChildProfilePrompt />

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
                      <CategoryTile category={c.glyph} />
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

            {/* ── A live taste of what's on now (client island; hides if empty) ── */}
            <HomeTodayStrip />

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
