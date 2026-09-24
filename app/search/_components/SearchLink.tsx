// SearchLink — next/link with viewport prefetching OFF. Every link on /search uses this
// instead of importing next/link directly (tests/search/search-link-no-prefetch.test.ts
// enforces that).
//
// ═══ WHY (2026-09-24, beta-blocking) ═══
// Production has a Vercel Firewall rate-limit rule (project kids-fun, rule
// "search-rate-limit-log-test", added 2026-09-22 as bot containment): 40 requests / 60 s
// fixed window, keyed by IP, over path prefix /search and /api/search, action DENY (403,
// `x-vercel-mitigated: deny`). Next.js prefetches every <Link> that scrolls into view, and
// a prefetch is a real GET /search?…&_rsc=… that the firewall counts like any other request.
// /search renders ~30 visible filter/sort chip links, so ONE desktop page view cost ~29
// requests and ONE chip click ~20 more — a parent's second filter click inside a minute
// tripped the rule and got a full "403: Forbidden" page. Measured against a production build.
//
// WHAT TURNING IT OFF COSTS: nothing a parent can see. /search has no loading.js, so for this
// dynamic route Next's default prefetch only fetched the (shared) layout, never the results —
// a click always did a full server render anyway. Navigation stays client-side (soft nav,
// one RSC request per click); only the speculative background requests are gone.
import Link from 'next/link';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';

export const SearchLink = forwardRef<ElementRef<typeof Link>, ComponentPropsWithoutRef<typeof Link>>(
  function SearchLink(props, ref) {
    return <Link {...props} ref={ref} prefetch={false} />;
  },
);

export default SearchLink;
