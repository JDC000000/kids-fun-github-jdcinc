import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { forwardRef, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Guards the 2026-09-24 fix: /search's own <Link> prefetches tripped the production Vercel
// Firewall rate-limit rule (40 req / 60 s per IP over /search*, action deny) — see
// app/search/_components/SearchLink.tsx for the full reasoning.

const linkCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('next/link', () => ({
  default: forwardRef<HTMLAnchorElement, { href: string; children?: ReactNode; prefetch?: boolean }>(
    function MockLink(props, ref) {
      linkCalls.push({ ...props });
      return (
        <a ref={ref} href={props.href}>
          {props.children}
        </a>
      );
    },
  ),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  usePathname: () => '/search',
}));

import { SearchLink } from '@/app/search/_components/SearchLink';
import { FilterRail } from '@/app/search/_components/FilterRail';
import { SearchBar } from '@/app/search/_components/SearchBar';
import { DEFAULT_STATE, type SearchState } from '@/app/search/_lib/params';
import { SiteNav } from '@/app/_components/SiteNav';

const SEARCH_DIR = join(__dirname, '..', '..', 'app', 'search');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

beforeEach(() => {
  linkCalls.length = 0;
});

describe('/search links never prefetch', () => {
  it('no /search source file imports next/link directly — only SearchLink may', () => {
    const offenders = sourceFiles(SEARCH_DIR)
      .filter((path) => !path.endsWith(join('_components', 'SearchLink.tsx')))
      .filter((path) => /from\s+['"]next\/link['"]/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SEARCH_DIR, path));
    expect(offenders).toEqual([]);
  });

  it('SearchLink forces prefetch={false}, even when a caller asks for prefetch', () => {
    const html = renderToStaticMarkup(
      <SearchLink href="/search?when=today" prefetch>
        Today
      </SearchLink>,
    );
    expect(html).toBe('<a href="/search?when=today">Today</a>');
    expect(linkCalls).toHaveLength(1);
    expect(linkCalls[0].prefetch).toBe(false);
  });

  it('every filter-rail and sort chip link renders with prefetch={false}', () => {
    // Near-me active + a filter applied so the radius chips and the Clear links render too.
    const state: SearchState = { ...DEFAULT_STATE, lat: 49.28, lng: -123.1, free: true };
    renderToStaticMarkup(
      <>
        <SearchBar state={state} />
        <FilterRail state={state} savedLocation={null} />
      </>,
    );
    // The rail alone is ~30+ links; a low floor so this fails loudly if the mock stops
    // intercepting rather than passing vacuously on zero links.
    expect(linkCalls.length).toBeGreaterThan(20);
    expect(linkCalls.filter((p) => p.prefetch !== false)).toEqual([]);
  });

  it('the site nav (rendered on every page, including /search) never prefetches its /search shortcuts', () => {
    renderToStaticMarkup(<SiteNav smsSignupHref="/sms/start" />);
    const searchLinks = linkCalls.filter((p) => String(p.href).startsWith('/search'));
    expect(searchLinks.length).toBeGreaterThan(3);
    expect(searchLinks.filter((p) => p.prefetch !== false)).toEqual([]);
  });

  it('the homepage tiles and the 404 page never prefetch their /search shortcuts', () => {
    // Both are server components with data dependencies, so this is a source check: every
    // <Link> whose href is built from the shared /search destinations must opt out.
    for (const file of ['page.tsx', 'not-found.tsx']) {
      const src = readFileSync(join(__dirname, '..', '..', 'app', file), 'utf8');
      const searchLinks = src
        .split('\n')
        .filter((line) => line.includes('<Link') && /destinationHref|SEARCH_SHORTCUTS/.test(line));
      expect(searchLinks.length, file).toBeGreaterThan(0);
      expect(searchLinks.filter((line) => !line.includes('prefetch={false}')), file).toEqual([]);
    }
  });
});
