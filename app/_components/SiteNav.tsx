'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AccountNav } from './AccountNav';
import { hidesAccountNav } from '@/lib/sms/surfaces';
import {
  SEARCH_SHORTCUTS,
  destinationHref,
  liveCategoryDestinations,
} from '@/app/_lib/nav-destinations';
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
 * is no structured category param. These are LITERALLY the same queries the home page's
 * category tiles use: both surfaces render app/_lib/nav-destinations.ts, so a label, a
 * caption or a retirement changes in one place for the whole product. This bar's own link
 * SET is unchanged by that move — "What's on now" and "Free" still bracket the category run.
 *
 * CLIENT COMPONENT, BUT NOT A CLIENT-ONLY ONE
 * `usePathname` resolves during server rendering too, so the full bar is in the HTML on
 * first paint and works with JavaScript disabled — the hook only supplies `aria-current`.
 * `useSearchParams` is deliberately NOT used: it would opt every static page into dynamic
 * rendering for the sake of marking a shortcut link.
 */

interface NavLink {
  href: string;
  label: string;
  /** Structural destinations get the emphasis; category shortcuts read as a quieter row. */
  primary?: boolean;
}

/**
 * NOT LINKED, ON PURPOSE: "Festivals" (`/search?q=festival`) — it returns ZERO results.
 *
 * This used to be a local `DEAD_CATEGORY` href that `LINKS` was filtered against, and that
 * filter was inert: the href it excluded was never in `LINKS`, so it matched nothing while
 * the home page went on rendering the dead tile. The exclusion now comes from the shared
 * list's `status` field, which is the single place that decides it for every surface at
 * once and which tests/nav-destinations.test.tsx checks against a real search.
 */
const LINKS: NavLink[] = [
  { href: SEARCH_SHORTCUTS.onNow.href, label: SEARCH_SHORTCUTS.onNow.label, primary: true },
  ...liveCategoryDestinations().map((d) => ({ href: destinationHref(d), label: d.label })),
  { href: SEARCH_SHORTCUTS.free.href, label: SEARCH_SHORTCUTS.free.label },
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
            {LINKS.map((link) => (
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

        {/*
          HIDDEN ON THE SMS SURFACES (PRD §8 item 4, Jon-approved). An SMS subscriber has no
          account — that is the product's premise — so offering "Sign in with Google" on the page
          where somebody is signing up by phone number invites a data relationship the product
          deliberately does not need. Jon's own framing: "let's emphasize capturing the least
          amount of data we need to provide value."

          The route list lives in lib/sms/surfaces.ts rather than here, so the SMS product's own
          map of itself stays with the SMS product. This file only asks the question.

          WHERE THIS STILL APPLIES: /activity/…, /search and /u/… — pages a person browses or
          manages something on. The rest of the bar stays there, and only the account touchpoint
          goes.

          SUPERSEDED FOR THE TWO SIGNUP PAGES (Jon, 2026-09-01). This comment used to read "the
          rest of the bar stays: a parent who lands on the signup form from a QR code should still
          be able to reach the catalogue. It is the ACCOUNT touchpoint that does not belong, not
          the navigation." That was true of /sms/signup until Jon reweighed it against conversion
          focus and ruled the nav friction there too. /sms/signup and /sms/start now render with no
          chrome at all via BARE_CHROME_PREFIXES, so on those two routes this component never
          renders and the question below is moot rather than answered differently.
        */}
        {!hidesAccountNav(pathname) && <AccountNav />}
      </div>
    </header>
  );
}
