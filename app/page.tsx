import Link from 'next/link';
import './_components/home.css';
import { CategoryTile } from './preview/_components/CategoryTile';
import type { Category } from './preview/_data/types';
import { HomeTodayStrip } from './_components/HomeTodayStrip';

// Home / front door (M3 Screen 1, Visual Blueprint v0.2). The first thing a
// first-time parent sees: it introduces KIDS FUN in the civic field-guide voice,
// gives one prominent way to search, and routes into the real product surfaces —
// /search (the scan page) and /preview/[id] (detail). It is deliberately NOT a
// second results page: it is the entry point that ties the built surfaces together.
//
// Server component: static, zero-JS to first paint, fast. The only client island
// is the small "on now" taste strip, which degrades to nothing if data is unavailable
// so the front door is always complete.

export const metadata = {
  title: 'KIDS FUN — What’s on for your kids across Metro Vancouver',
  description:
    'A civic field guide to real kids’ activities across Metro Vancouver — the source and last-checked date on every listing, so you can trust it before you go.',
};

/**
 * Category entry points. Each `q` is a free-text query the /search parser resolves —
 * the only category mechanism /search actually supports (no invented structured param).
 * Every query here is confirmed to return REAL staging-database listings (2026-07-14):
 * family swim→5 public_swim · storytime→15 · soft play→6 indoor_play · festival→6
 * festival_event · program→34 class_program. Deliberately NO open_gym / skate / nature
 * tiles — those categories have zero real listings on the three live sources today.
 * `glyph` is the illustration-system category (D4); it matches how /search's mapCategory
 * renders the same rows (class_program → museum_arts glyph).
 */
const CATEGORIES: { label: string; caption: string; glyph: Category; q: string }[] = [
  { label: 'Swimming', caption: 'Pools & family swim', glyph: 'swim', q: 'family swim' },
  { label: 'Storytime', caption: 'Libraries & early years', glyph: 'storytime', q: 'storytime' },
  { label: 'Indoor play', caption: 'Rainy-day soft play', glyph: 'indoor_play', q: 'soft play' },
  { label: 'Festivals', caption: 'Free community events', glyph: 'festival', q: 'festival' },
  { label: 'Classes & programs', caption: 'Community-centre programs', glyph: 'museum_arts', q: 'program' },
];

// Concrete "Quick starts" (Blueprint D5) — saved filter searches, not marketing tiles.
// Each uses a structured param /search supports; all confirmed non-empty on staging.
const QUICK_STARTS: { label: string; href: string }[] = [
  { label: 'Free things to do', href: '/search?free=1' },
  { label: 'Rainy-day & indoor', href: '/search?rainy=1' },
  { label: 'Browse everything on now', href: '/search' },
];

const TRUST: { title: string; copy: string }[] = [
  {
    title: 'Approved public sources only',
    copy: 'Listings come from public library and City of Vancouver calendars — nothing scraped behind a login, no invented events.',
  },
  {
    title: 'Source & last-checked on every listing',
    copy: 'Each card shows where it came from and when we last checked it, so you can trust the details before you head out.',
  },
  {
    title: 'Confirmed and expected are never blurred',
    copy: 'Not-yet-posted or seasonal listings sit in their own labelled section — we never dress up an expectation as a confirmed plan.',
  },
];

function searchHref(q: string): string {
  return `/search?q=${encodeURIComponent(q)}`;
}

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
                <input
                  id="kf-home-q"
                  className="kf-home__search-input"
                  type="search"
                  name="q"
                  placeholder="family swim, storytime, soft play…"
                  autoComplete="off"
                  enterKeyHint="search"
                  aria-label="Search kids' activities across Metro Vancouver"
                />
                <button className="kf-home__search-btn" type="submit">
                  Search
                </button>
              </div>
            </form>
          </header>

          <main className="kf-home__main">
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
                  <li key={c.q}>
                    <Link className="kf-home__tile" href={searchHref(c.q)}>
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

            {/* ── Quick starts — concrete saved-filter searches (D5) ── */}
            <section className="kf-home__section" aria-labelledby="kf-home-quick">
              <div className="kf-section__head">
                <h2 className="kf-section__title" id="kf-home-quick">
                  Quick starts
                </h2>
                <span className="kf-section__rule" aria-hidden="true" />
              </div>
              <div className="kf-home__quick" role="list">
                {QUICK_STARTS.map((q) => (
                  <Link key={q.href} className="kf-home__quick-chip" href={q.href} role="listitem">
                    {q.label}
                  </Link>
                ))}
              </div>
            </section>

            {/* ── A live taste of what's on now (client island; hides if empty) ── */}
            <HomeTodayStrip />

            {/* ── How KIDS FUN works — the honesty/trust differentiator ── */}
            <section className="kf-home__section" aria-labelledby="kf-home-trust">
              <div className="kf-section__head">
                <h2 className="kf-section__title" id="kf-home-trust">
                  How KIDS FUN works
                </h2>
                <span className="kf-section__rule" aria-hidden="true" />
              </div>
              <ul className="kf-home__trust">
                {TRUST.map((t) => (
                  <li className="kf-home__trust-item" key={t.title}>
                    <span className="kf-home__trust-badge" aria-hidden="true">
                      ✓
                    </span>
                    <span>
                      <span className="kf-home__trust-title">{t.title}</span>
                      <span className="kf-home__trust-copy">{t.copy}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </main>

          <footer className="kf-home__footer">
            <p className="kf-home__footer-word">KIDS FUN</p>
            <p className="kf-home__footer-note">
              A civic field guide to kids&apos; activities across Metro Vancouver. Staging preview — coverage grows as
              more public sources come online.
            </p>
          </footer>
        </div>
      </div>
    </div>
  );
}
