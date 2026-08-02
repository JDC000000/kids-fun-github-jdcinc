'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AccountNav } from './AccountNav';
import './site-nav.css';

/**
 * SiteNav — the product's global navigation (Round 31).
 *
 * WHY THIS EXISTS
 * Measured on the deployed build, the entire desktop "navigation" was a 50px bar containing
 * one control: "Sign in with Google". No home link, no wordmark link, no route back to the
 * browse categories, no saved searches. A parent who landed on a shared /search link had no
 * way to reach anything else in the product. That is a bigger gap in "a fuller desktop
 * experience" than the filter layout, and a cheaper one to close.
 *
 * WHAT IT IS
 * One bar: wordmark → home, a row of real destinations, and the pre-existing account
 * touchpoint on the right. AccountNav is rendered inside it unchanged — it keeps its own
 * `<nav aria-label="Account">` landmark, which is a legitimate second navigation region
 * beside this one's "Main", and its /api/me probe and sign-out POST are untouched.
 *
 * WHY THE DESTINATIONS ARE SEARCH QUERIES
 * `/search?q=…` free text is the only category mechanism /search actually supports — there
 * is no structured category param. These are the same queries the home page's category
 * tiles use, and each one is confirmed to return real listings. See DEAD_CATEGORY below for
 * the one that is deliberately absent.
 *
 * CLIENT COMPONENT, BUT NOT A CLIENT-ONLY ONE
 * `usePathname` resolves during server rendering too, so the full bar is in the HTML on
 * first paint and works with JavaScript disabled — the hook only supplies `aria-current`.
 * `useSearchParams` is deliberately NOT used: it would opt every static page into dynamic
 * rendering for the sake of marking a shortcut link.
 */

/**
 * NOT LINKED, ON PURPOSE: "Festivals" (`/search?q=festival`).
 *
 * The home page still carries that tile, and it returns ZERO results — verified against
 * both the fixture engine and the deployed build. app/page.tsx's own comment records the
 * query returning 6 real listings on 2026-07-14, so this is a data regression, not a
 * missing feature. Putting a known-dead link into new, MORE prominent navigation would
 * multiply the damage, so it stays out until the underlying zero-result bug is fixed.
 * Raised separately; deliberately not fixed as a side effect of this work.
 */
const DEAD_CATEGORY = '/search?q=festival';

interface NavLink {
  href: string;
  label: string;
  /** Structural destinations get the emphasis; category shortcuts read as a quieter row. */
  primary?: boolean;
}

const LINKS: NavLink[] = [
  { href: '/search', label: 'What’s on now', primary: true },
  { href: '/search?q=family+swim', label: 'Swimming' },
  { href: '/search?q=storytime', label: 'Storytime' },
  { href: '/search?q=soft+play', label: 'Indoor play' },
  { href: '/search?q=program', label: 'Classes' },
  { href: '/search?free=1', label: 'Free' },
];

export function SiteNav() {
  const pathname = usePathname();

  /**
   * `aria-current="page"` only for links that ARE a page rather than a query against one.
   * "/search?q=storytime" and "/search?free=1" are shortcuts INTO the search page; marking
   * them current whenever a parent is anywhere on /search would be a claim the URL does not
   * support, and marking them by query would need useSearchParams (see the note above).
   */
  const current = (link: NavLink): 'page' | undefined =>
    !link.href.includes('?') && pathname === link.href ? 'page' : undefined;

  return (
    <header className="kf-nav">
      <div className="kf-nav__inner">
        <Link className="kf-nav__word" href="/" aria-current={pathname === '/' ? 'page' : undefined}>
          KIDS<span className="kf-nav__word-b">FUN</span>
        </Link>

        <nav className="kf-nav__primary" aria-label="Main">
          <ul className="kf-nav__list">
            {LINKS.filter((l) => l.href !== DEAD_CATEGORY).map((link) => (
              <li key={link.href}>
                <Link
                  className={link.primary ? 'kf-nav__link kf-nav__link--strong' : 'kf-nav__link'}
                  href={link.href}
                  aria-current={current(link)}
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <AccountNav />
      </div>
    </header>
  );
}
