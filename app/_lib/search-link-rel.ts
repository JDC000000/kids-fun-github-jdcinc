// app/_lib/search-link-rel.ts — rel="nofollow" for links that point at a /search PERMUTATION.
//
// ═══ WHY (2026-09-24, Vercel cost spike) ═══
// GPTBot walked /search filter permutations from the night the domain was attached: every chip
// on /search is a real <a href="/search?…"> (deliberately — deep links, back button, JS-off),
// so each results page handed a crawler ~30 new URLs, each of which ran a function. That was
// ~96% of the cycle's bill. The approved controls are three layers, each covering a crawler the
// others miss:
//   1. app/robots.ts disallows /search           — crawlers that read robots.txt never fetch it.
//   2. app/search/layout.tsx noindex,nofollow    — crawlers that fetch the page anyway.
//   3. THIS: rel="nofollow" on links INTO a      — crawlers that skip both but honour the link
//      /search permutation, wherever they render   hint, and links on pages that stay indexable.
//
// ═══ WHAT COUNTS AS A PERMUTATION ═══
// A same-site href whose path is /search AND which carries a query string: every chip, sort,
// clear, broadening alternative, category shortcut and saved search. A BARE `/search` does not
// count: it is ONE url, it is the canonical entry point (the nav's "What's on now", the "back to
// search" links), and nofollowing it would buy nothing — it is not what a crawler multiplies.
// Absolute URLs (any origin) are left alone: nothing on the site emits one for /search, and
// a helper that guessed at other hosts would be wrong in a way no test here would notice.
//
// rel="nofollow" changes nothing for a parent: navigation, referrer, prefetch and analytics are
// all unaffected. It is only a hint to crawlers.
import type { UrlObject } from 'url';

const SEARCH_PATHS = new Set(['/search', '/search/']);

/** Parsing base for relative hrefs. `.invalid` is reserved (RFC 2606), so it can never be real. */
const RELATIVE_BASE = 'http://relative.invalid';

function hasQuery(query: UrlObject['query']): boolean {
  if (query == null) return false;
  if (typeof query === 'string') return query.replace(/^\?/, '').length > 0;
  return Object.keys(query).length > 0;
}

/** True when `href` is a same-site `/search?…` URL — a filter/facet permutation of /search. */
export function isSearchPermutationHref(href: string | UrlObject): boolean {
  if (typeof href !== 'string') {
    if (href.host || href.hostname || href.protocol) return false;
    const search = typeof href.search === 'string' ? href.search.replace(/^\?/, '') : '';
    return SEARCH_PATHS.has(href.pathname ?? '') && (hasQuery(href.query) || search.length > 0);
  }
  let url: URL;
  try {
    url = new URL(href, RELATIVE_BASE);
  } catch {
    return false;
  }
  if (url.origin !== RELATIVE_BASE) return false;
  return SEARCH_PATHS.has(url.pathname) && url.search.length > 1;
}

/**
 * The `rel` to render on a link to `href`: `existing` plus `nofollow` when `href` is a /search
 * permutation, otherwise `existing` unchanged (so a non-permutation link renders no `rel` at all
 * unless its caller asked for one).
 */
export function searchLinkRel(href: string | UrlObject, existing?: string): string | undefined {
  if (!isSearchPermutationHref(href)) return existing;
  const tokens = (existing ?? '').split(/\s+/).filter(Boolean);
  if (!tokens.includes('nofollow')) tokens.push('nofollow');
  return tokens.join(' ');
}
