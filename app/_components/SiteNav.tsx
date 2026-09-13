'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
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
 * One bar: wordmark → home and a row of real destinations. It used to also carry the account
 * touchpoint (AccountNav, with its own `<nav aria-label="Account">` landmark and a /api/me
 * probe); that was removed on 2026-09-12 along with Google sign-in, so this bar now has a
 * single navigation region and makes no authenticated request. See the note at the render
 * site below.
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
 * first paint and works with JavaScript disabled — the hook only supplies `aria-current`
 * and the menu's close-on-navigate convenience (see NAV_MENU below). Nothing a parent needs
 * in order to REACH a destination depends on JavaScript.
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
   * ═══ NAV_MENU: CLOSE THE COMPACT MENU WHEN THE ROUTE CHANGES ═══
   * App-Router navigation does not remount this component, so a `<details>` a parent opened
   * would still be open, overlaying the page they just asked for. Resetting it on pathname
   * change is a PROGRESSIVE ENHANCEMENT, not a requirement: with JavaScript off the menu
   * still opens, still lists every destination, and still navigates — it simply stays open,
   * which is exactly how a native `<details>` behaves on a full page load anyway.
   */
  const menuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (menuRef.current) menuRef.current.open = false;
  }, [pathname]);

  /**
   * `aria-current="page"` only for links that ARE a page rather than a query against one.
   * "/search?q=storytime" and "/search?free=1" are shortcuts INTO the search page; marking
   * them current whenever a parent is anywhere on /search would be a claim the URL does not
   * support, and marking them by query would need useSearchParams (see the note above).
   */
  const current = (link: NavLink): 'page' | undefined =>
    !link.href.includes('?') && pathname === link.href ? 'page' : undefined;

  /**
   * ONE renderer for BOTH the wide inline row and the narrow compact menu.
   *
   * The two surfaces render the SAME `LINKS` array through the SAME function, so they cannot
   * drift in label, href or order — the failure mode app/_lib/nav-destinations.ts exists to
   * prevent. Only ONE of them is ever displayed (the media queries in site-nav.css are
   * mutually exclusive), and `display: none` removes the other from the accessibility tree
   * as well as the layout, so a screen reader is never offered the destinations twice.
   */
  const renderLink = (link: NavLink) => (
    <li key={link.href}>
      <Link
        className={link.primary ? 'kf-nav__link kf-nav__link--strong' : 'kf-nav__link'}
        href={link.href}
        aria-current={current(link)}
      >
        {link.label}
      </Link>
    </li>
  );

  return (
    <header className="kf-nav">
      <div className="kf-nav__inner">
        <Link className="kf-nav__word" href="/" aria-current={pathname === '/' ? 'page' : undefined}>
          KIDS<span className="kf-nav__word-b">FUN</span>
        </Link>

        <nav className="kf-nav__primary" aria-label="Main">
          {/* ≥768px: the destinations as a single inline row, unchanged from Round 31. */}
          <ul className="kf-nav__list">{LINKS.map(renderLink)}</ul>

          {/*
            ═══ <768px: THE COMPACT MENU, AND WHY THE SCROLLING STRIP HAD TO GO ═══
            The strip was measured at 390px (a stock iPhone 14/15 viewport): 200px of a 456px
            row was visible. "What's on now" and "Swimming" fitted, "Storytime" was cut
            mid-word, and "Indoor play", "Classes" and "Free" — half the catalogue's front
            doors — were off the end with no affordance a parent would notice. The 2026-09-03
            pass had already reclaimed ~80px by shedding "with Google" from the sign-in pill;
            that helped and was not close to enough, because six pills need ~456px and a
            390px phone can only ever offer ~200px of them once the wordmark and the account
            control have taken their share. NO amount of tuning a horizontal scroller fixes
            an arithmetic problem: the row is more than twice the width available.

            SHORTER LABELS WERE THE OTHER OPTION AND WERE REJECTED. The labels are not
            SiteNav's to shorten — they come from app/_lib/nav-destinations.ts, the single
            vocabulary the home page's tiles render too, and abbreviating them HERE would
            re-create the hand-maintained second list that file was written to delete.
            Abbreviating them THERE would rename the categories product-wide, which is a
            copy decision and not a layout fix.

            NATIVE <details>, NO JAVASCRIPT — the same choice StartForm's legal block makes,
            for the same reason: it is server-rendered, it works with scripting disabled, and
            there is no open/closed state to hydrate. The panel is absolutely positioned, so
            a CLOSED menu costs the bar no height at all — which keeps the promise the
            scrolling strip was originally chosen to keep ("a wrapping nav would push the
            whole page down, and this bar's height budget is the thing paying for results
            above the fold"). Wrapping to two rows would have broken it; this does not.
          */}
          <details className="kf-nav__more" ref={menuRef}>
            <summary className="kf-nav__more-toggle">
              <svg
                className="kf-nav__more-icon"
                viewBox="0 0 16 16"
                width="16"
                height="16"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  d="M1 3h14M1 8h14M1 13h14"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
              {/* A word, not a bare glyph. The hamburger alone is a convention rather than a
                  label, and this bar's whole reason for existing is that parents could not
                  tell what the product could take them to. */}
              Menu
            </summary>
            <ul className="kf-nav__menu">{LINKS.map(renderLink)}</ul>
          </details>
        </nav>

        {/*
          THE ACCOUNT TOUCHPOINT IS GONE ENTIRELY (Jon, 2026-09-12): "the only product i want to
          promote is the SMS product. we don't want people to sign in with google. this
          functionality adds no value. remove it."

          This is the END of a trajectory rather than a reversal. The pill was already hidden on
          every SMS surface and on /activity/…, /preview/…, /search and /u/… (lib/sms/surfaces.ts
          `hidesAccountNav`), on Jon's reasoning that "an SMS subscriber has no account — that is
          the product's premise" and "let's emphasize capturing the least amount of data we need
          to provide value". The route list had grown to cover nearly everything a parent actually
          visits; this removes the remainder, so there is no longer a route-dependent question to
          ask and `hidesAccountNav` no longer has a caller here.

          `hidesAccountNav` is deliberately LEFT IN PLACE in lib/sms/surfaces.ts: it is the SMS
          product's own map of itself, it is still covered by tests/sms/surfaces.test.ts, and
          retiring it is a separate decision from removing this bar's pill.

          WHAT WAS NOT REMOVED HERE: the /auth/* routes, /account, /api/me and the saved-search
          backend still exist and are unreferenced by any navigation. Deleting that subsystem is a
          product-scope call (it also owns the PIPEDA export/delete endpoints), so it is flagged
          for review rather than folded into a nav change.
        */}
      </div>
    </header>
  );
}
