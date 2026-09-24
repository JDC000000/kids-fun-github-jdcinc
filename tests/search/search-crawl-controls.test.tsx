// tests/search/search-crawl-controls.test.tsx — the three crawler controls on /search (2026-09-24).
//
// GPTBot walking /search filter permutations was ~96% of the Aug–Sep Vercel bill. Jon approved
// three layers, and this file pins each one AND the edge that makes it safe:
//   1. robots.txt disallows /search, and every rule that was already there survives.
//   2. /search (every query-string variant) carries noindex,nofollow, and NO other route does.
//   3. every link into a /search PERMUTATION carries rel="nofollow"; bare /search and every
//      non-search link do not.
// See app/robots.ts, app/search/layout.tsx and app/_lib/search-link-rel.ts for the reasoning.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { forwardRef, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Metadata } from 'next';
// The SAME serializers Next uses for /robots.txt and for the <meta name="robots"> tag, so these
// assertions are about the bytes a crawler receives, not about an object shape. Internal paths
// (next 14.2): if an upgrade moves them this file fails to import, loudly, which is the point.
import { resolveRobots as serializeRobotsTxt } from 'next/dist/build/webpack/loaders/metadata/resolve-route-data';
import { resolveRobots as resolveRobotsMeta } from 'next/dist/lib/metadata/resolvers/resolve-basics';

// next/link → a plain <a> that forwards href AND rel, so the rendered HTML shows exactly the rel
// each call site hands to Link (the real Link spreads rel onto its <a> the same way).
vi.mock('next/link', () => ({
  default: forwardRef<HTMLAnchorElement, { href: string; rel?: string; children?: ReactNode }>(
    function MockLink({ href, rel, children }, ref) {
      return (
        <a ref={ref} href={href} rel={rel}>
          {children}
        </a>
      );
    },
  ),
}));
// <ThreeThings /> is an async server component the home page imports; only the page's metadata
// is read here, so it is stubbed exactly as tests/home/front-door.test.tsx stubs it.
vi.mock('@/app/_components/ThreeThings', () => ({ ThreeThings: () => null }));
// next/font is a build-time transform with no runtime under vitest; the root layout is imported
// only to read its metadata.
vi.mock('next/font/google', () => {
  const font = () => ({ className: 'font', variable: '--font', style: { fontFamily: 'font' } });
  return { Manrope: font, Fraunces: font };
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  usePathname: () => '/search',
}));

import robots from '@/app/robots';
import { metadata as searchLayoutMetadata } from '@/app/search/layout';
import { metadata as rootLayoutMetadata } from '@/app/layout';
import { metadata as notFoundMetadata } from '@/app/not-found';
import { metadata as coverageMetadata } from '@/app/coverage-status/page';
import { metadata as privacyMetadata } from '@/app/privacy/page';
import { metadata as termsMetadata } from '@/app/terms/page';
import { buildDetailMetadata } from '@/app/preview/_data/detail-metadata';
import { findActivity } from '@/app/preview/_data/fixtures';
import type { Activity } from '@/app/preview/_data/types';
import { isSearchPermutationHref, searchLinkRel } from '@/app/_lib/search-link-rel';
import { SearchLink } from '@/app/search/_components/SearchLink';
import { FilterRail } from '@/app/search/_components/FilterRail';
import { SearchBar } from '@/app/search/_components/SearchBar';
import { QuerySummary } from '@/app/search/_components/QuerySummary';
import { DEFAULT_STATE, type SearchState } from '@/app/search/_lib/params';
import { SiteNav } from '@/app/_components/SiteNav';
import LinkUnavailablePage from '@/app/link-unavailable/page';
import ActivityUnavailablePage from '@/app/activity-unavailable/page';
import { SavedSearches } from '@/app/account/_components/SavedSearches';

const APP_DIR = join(__dirname, '..', '..', 'app');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Every <a …> in `html`, as { href, rel } (attribute values are HTML-escaped; decode &amp;). */
function anchors(html: string): Array<{ href: string; rel: string | null }> {
  return [...html.matchAll(/<a\b([^>]*)>/g)].map(([, attrs]) => ({
    href: (attrs.match(/\shref="([^"]*)"/)?.[1] ?? '').replace(/&amp;/g, '&'),
    rel: attrs.match(/\srel="([^"]*)"/)?.[1] ?? null,
  }));
}

const relTokens = (rel: string | null) => (rel ?? '').split(/\s+/).filter(Boolean);

/**
 * RFC 9309 matching for the `*` group of a robots.txt body: the longest matching Allow/Disallow
 * path wins, and Allow wins a tie. Enough to answer "may a crawler fetch this URL?" for the
 * prefix-only rules app/robots.ts emits (no `*`/`$` wildcards are used there).
 */
function crawlerMayFetch(robotsTxt: string, pathAndQuery: string): boolean {
  let best: { length: number; allow: boolean } | null = null;
  for (const line of robotsTxt.split('\n')) {
    const m = line.match(/^(Allow|Disallow):\s*(\S*)$/);
    if (!m || m[2] === '' || !pathAndQuery.startsWith(m[2])) continue;
    const candidate = { length: m[2].length, allow: m[1] === 'Allow' };
    if (!best || candidate.length > best.length || (candidate.length === best.length && candidate.allow)) {
      best = candidate;
    }
  }
  return best?.allow ?? true;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('1 — robots.txt disallows /search and keeps every existing rule', () => {
  const txt = serializeRobotsTxt(robots());

  it('serializes to exactly the previous file plus one `Disallow: /search` line', () => {
    expect(txt).toBe(
      [
        'User-Agent: *',
        'Allow: /',
        'Disallow: /admin',
        'Disallow: /api',
        'Disallow: /u/',
        'Disallow: /s/',
        'Disallow: /preview',
        'Disallow: /search',
        '',
        'Host: https://kidsfunapp.ca',
        'Sitemap: https://kidsfunapp.ca/sitemap.xml',
        '',
      ].join('\n'),
    );
  });

  it('keeps the sitemap reference, the host and every pre-existing disallow (the /u/ and /s/ privacy rules included)', () => {
    const r = robots();
    expect(r.sitemap).toBe('https://kidsfunapp.ca/sitemap.xml');
    expect(r.host).toBe('https://kidsfunapp.ca');
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    expect(rules).toHaveLength(1);
    expect(rules[0].userAgent).toBe('*');
    expect(rules[0].allow).toBe('/');
    expect(rules[0].disallow).toEqual(expect.arrayContaining(['/admin', '/api', '/u/', '/s/', '/preview', '/search']));
  });

  it('blocks the bare page and every permutation, including the ones GPTBot walked', () => {
    for (const url of [
      '/search',
      '/search?when=weekend',
      '/search?q=swimming',
      '/search?free=1&when=today&age=3-5&region=nvan&sort=distance',
      '/search/',
    ]) {
      expect(crawlerMayFetch(txt, url), url).toBe(false);
    }
  });

  it('still allows the pages that are meant to be indexed', () => {
    for (const url of ['/', '/activity/trout-lake-public-skate', '/coverage-status', '/privacy', '/terms', '/sitemap.xml']) {
      expect(crawlerMayFetch(txt, url), url).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('2 — /search is noindex,nofollow, on every variant, and on nothing else', () => {
  it('the /search segment declares robots noindex,nofollow, which Next renders as "noindex, nofollow"', () => {
    expect(searchLayoutMetadata.robots).toEqual({ index: false, follow: false });
    expect(resolveRobotsMeta(searchLayoutMetadata.robots)?.basic).toBe('noindex, nofollow');
  });

  it('is STATIC — nothing under app/search can vary it per query string or override it per page', () => {
    // A generateMetadata that read searchParams could let a variant escape the directive, and a
    // page-level `metadata` would replace the layout's `robots` for that page. Neither exists.
    const searchDir = join(APP_DIR, 'search');
    const declaring = sourceFiles(searchDir)
      .filter((path) => /export\s+(const\s+metadata\b|(async\s+)?function\s+generateMetadata\b)/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(searchDir, path));
    expect(declaring).toEqual(['layout.tsx']);
  });

  it('the root layout declares no robots directive (it would reach every route)', () => {
    expect(rootLayoutMetadata).not.toHaveProperty('robots');
  });

  it('no layout other than /search’s declares robots — a layout is the only way a directive leaks to other routes', () => {
    const layoutsWithRobots = sourceFiles(APP_DIR)
      .filter((path) => /(^|\/)layout\.tsx?$/.test(path))
      .filter((path) => /\brobots\s*:/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(APP_DIR, path));
    expect(layoutsWithRobots).toEqual([join('search', 'layout.tsx')]);
  });

  it('the home page, an activity page, the 404 and the static public pages stay indexable', async () => {
    const { metadata: homeMetadata } = await import('@/app/page');
    const skate = findActivity('trout-lake-public-skate') as Activity;
    const activityMetadata = buildDetailMetadata(skate, 'trout-lake-public-skate');
    const routes: Record<string, Metadata> = {
      '/': homeMetadata,
      '/activity/[id]': activityMetadata,
      'not-found': notFoundMetadata,
      '/coverage-status': coverageMetadata,
      '/privacy': privacyMetadata,
      '/terms': termsMetadata,
    };
    for (const [route, metadata] of Object.entries(routes)) {
      const resolved = resolveRobotsMeta(metadata.robots);
      expect(resolved?.basic ?? '', route).not.toMatch(/noindex|nofollow/);
    }
  });

  it('the activity route builds its metadata from buildDetailMetadata (the builder asserted above)', () => {
    const src = readFileSync(join(APP_DIR, 'activity', '[id]', 'page.tsx'), 'utf8');
    expect(src).toMatch(/buildDetailMetadata\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('3a — which hrefs are /search permutations', () => {
  it.each([
    ['/search?when=today', true],
    ['/search?q=swimming', true],
    ['/search?free=1&when=today&lat=49.2827&lng=-123.1207&radius=5&sort=distance', true],
    ['/search/?free=1', true],
    ['/search', false],
    ['/search?', false],
    ['/search/', false],
    ['/', false],
    ['/searching?x=1', false],
    ['/search-help?x=1', false],
    ['/preview/abc?from=search', false],
    ['/activity/abc', false],
    ['/api/search?q=swim', false],
    ['https://kidsfunapp.ca/search?when=today', false],
    ['https://example.com/search?q=x', false],
    ['sms:+16045550100', false],
    ['#kf-home-search', false],
  ])('%s → %s', (href, expected) => {
    expect(isSearchPermutationHref(href)).toBe(expected);
  });

  it('understands next/link UrlObject hrefs too', () => {
    expect(isSearchPermutationHref({ pathname: '/search', query: { free: '1' } })).toBe(true);
    expect(isSearchPermutationHref({ pathname: '/search', search: '?when=today' })).toBe(true);
    expect(isSearchPermutationHref({ pathname: '/search' })).toBe(false);
    expect(isSearchPermutationHref({ pathname: '/search', query: {} })).toBe(false);
    expect(isSearchPermutationHref({ pathname: '/preview', query: { a: '1' } })).toBe(false);
    expect(isSearchPermutationHref({ protocol: 'https:', host: 'example.com', pathname: '/search', query: { a: '1' } })).toBe(false);
  });

  it('searchLinkRel adds nofollow once, keeps any rel the caller set, and adds nothing to other links', () => {
    expect(searchLinkRel('/search?when=today')).toBe('nofollow');
    expect(searchLinkRel('/search?when=today', 'noopener')).toBe('noopener nofollow');
    expect(searchLinkRel('/search?when=today', 'nofollow')).toBe('nofollow');
    expect(searchLinkRel('/search?when=today', '  noreferrer   noopener ')).toBe('noreferrer noopener nofollow');
    expect(searchLinkRel('/search')).toBeUndefined();
    expect(searchLinkRel('/preview/x', 'noopener')).toBe('noopener');
  });
});

describe('3b — rel="nofollow" on every link into a /search permutation, and nowhere else', () => {
  it('SearchLink (every link on /search goes through it) nofollows permutations only', () => {
    expect(renderToStaticMarkup(<SearchLink href="/search?when=today">Today</SearchLink>)).toBe(
      '<a href="/search?when=today" rel="nofollow">Today</a>',
    );
    expect(renderToStaticMarkup(<SearchLink href="/search">All</SearchLink>)).toBe('<a href="/search">All</a>');
    expect(renderToStaticMarkup(<SearchLink href="/preview/abc">Card</SearchLink>)).toBe('<a href="/preview/abc">Card</a>');
    expect(renderToStaticMarkup(<SearchLink href="/search?free=1" rel="noopener">Free</SearchLink>)).toBe(
      '<a href="/search?free=1" rel="noopener nofollow">Free</a>',
    );
  });

  it('the filter rail, the sort chips and the applied-filter summary: every /search? link is nofollow', () => {
    // Near-me + a date range + several filters, so the radius chips, the date-range clear, the
    // saved-location chips and every Clear link render too.
    const state: SearchState = {
      ...DEFAULT_STATE,
      q: 'swim',
      lat: 49.28,
      lng: -123.1,
      free: true,
      dropIn: true,
      dateFrom: '2026-09-26',
      dateTo: '2026-09-27',
    };
    const html = renderToStaticMarkup(
      <>
        <SearchBar state={state} />
        <FilterRail state={state} savedLocation={{ areaLabel: 'North Vancouver' }} />
        <QuerySummary
          state={state}
          tokens={[
            { key: 'free', label: 'Free', scope: 'other', clear: { free: false } },
            { key: 'drop-in', label: 'Drop-in', scope: 'other', clear: { dropIn: false } },
          ]}
          confirmed={3}
          expected={1}
          sortLabel="Best match"
          clearHref="/search?q=swim"
        />
      </>,
    );
    const searchLinks = anchors(html).filter((a) => a.href.startsWith('/search'));
    // A floor so this fails loudly if rendering stops producing links, rather than passing on zero.
    expect(searchLinks.length).toBeGreaterThan(25);
    const permutations = searchLinks.filter((a) => isSearchPermutationHref(a.href));
    expect(permutations.length).toBeGreaterThan(25);
    expect(permutations.filter((a) => !relTokens(a.rel).includes('nofollow'))).toEqual([]);
    expect(searchLinks.filter((a) => a.href === '/search' && a.rel !== null)).toEqual([]);
  });

  it('site nav: category and Free shortcuts are nofollow; the wordmark, "What’s on now" and the SMS entry are not', () => {
    const links = anchors(renderToStaticMarkup(<SiteNav smsSignupHref="/sms/start" />));
    const byHref = (href: string) => links.filter((a) => a.href === href);

    const shortcuts = links.filter((a) => isSearchPermutationHref(a.href));
    expect(shortcuts.length).toBeGreaterThan(3);
    expect(shortcuts.every((a) => relTokens(a.rel).includes('nofollow'))).toBe(true);
    expect(byHref('/search?free=1').length).toBeGreaterThan(0);

    for (const href of ['/', '/search', '/sms/start']) {
      expect(byHref(href).length, href).toBeGreaterThan(0);
      expect(byHref(href).filter((a) => a.rel !== null), href).toEqual([]);
    }
  });

  it('/link-unavailable (SMS click path): the weekend onward link is nofollow; the support link is not', () => {
    const links = anchors(renderToStaticMarkup(LinkUnavailablePage() as ReactElement));
    const onward = links.find((a) => a.href === '/search?when=weekend');
    expect(onward?.rel).toBe('nofollow');
    expect(links.filter((a) => a.href.startsWith('sms:')).every((a) => a.rel === null)).toBe(true);
  });

  it('/activity-unavailable: its bare /search onward link is left alone (not a permutation)', () => {
    const links = anchors(renderToStaticMarkup(ActivityUnavailablePage() as ReactElement));
    const onward = links.filter((a) => a.href === '/search');
    expect(onward).toHaveLength(1);
    expect(onward[0].rel).toBeNull();
  });

  it('/account saved searches: each "Open" link into /search is nofollow', () => {
    const html = renderToStaticMarkup(
      <SavedSearches
        initial={[
          { id: 'a', name: 'Swim', params: { q: 'swim', free: '1' }, created_at: '2026-07-01T00:00:00.000Z', last_run_at: null },
        ]}
      />,
    );
    const open = anchors(html).filter((a) => a.href.startsWith('/search?'));
    expect(open).toHaveLength(1);
    expect(open[0].rel).toBe('nofollow');
  });

  it('home tiles and the 404 page: every /search?… <Link> passes searchLinkRel; the bare "What’s on now" does not', () => {
    // Both are server components with data dependencies (tests/home/front-door.test.tsx and
    // tests/not-found-page.test.tsx render them); this is the same line-level source check the
    // no-prefetch guard uses for these two files.
    for (const file of ['page.tsx', 'not-found.tsx']) {
      const lines = readFileSync(join(APP_DIR, file), 'utf8').split('\n');
      const permutationLinks = lines.filter(
        (line) => line.includes('<Link') && /destinationHref\(|SEARCH_SHORTCUTS\.(free|rainy)\b/.test(line),
      );
      expect(permutationLinks.length, file).toBeGreaterThan(0);
      expect(permutationLinks.filter((line) => !/rel=\{searchLinkRel\(/.test(line)), file).toEqual([]);
      const onNow = lines.filter((line) => line.includes('<Link') && line.includes('SEARCH_SHORTCUTS.onNow'));
      expect(onNow.filter((line) => line.includes('rel=')), file).toEqual([]);
    }
  });
});
