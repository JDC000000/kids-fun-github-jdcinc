// app/sitemap.ts — /sitemap.xml, which 404'd until now (fresh-eyes QA audit, 2026-09-03).
//
// ═══ STATIC PUBLIC PAGES ONLY, AND THAT IS A DELIBERATE SCOPE ═══
// Per-listing activity pages are NOT listed. Production carries ~11,294 live occurrences, and they
// churn constantly — archived_at flips, freshness changes, occurrences age out. A sitemap of those
// would need a database read on every request, would be stale between the read and the crawl, and
// would spend the whole crawl budget on pages that may not exist next week. If per-listing
// inclusion is wanted later it should be its own decision with its own freshness story, not a
// side effect of adding a sitemap at all.
//
// ═══ WHAT IS EXCLUDED, AND WHY, SO NOBODY "COMPLETES" THIS LIST LATER ═══
//   /account              bounces anonymous visitors to sign-in — nothing for a crawler to index
//   /activity-unavailable already declares robots: { index: false, follow: false } in its own
//   /link-unavailable     metadata. Their comments: a search result pointing at either "would be a
//                         dead end for whoever clicked". Listing them here would contradict the
//                         pages. Both are reachable ONLY by redirect from /s/{token}.
//   /u/, /s/              per-subscriber tokenised URLs. See app/robots.ts.
//   /admin, /api          gated / not documents.
//   /search               REMOVED 2026-09-24 (Operator decision P1). robots.txt now disallows it and
//                         app/search/layout.tsx marks it noindex,nofollow, as crawler cost control
//                         (GPTBot walking filter permutations was ~96% of the Aug–Sep Vercel bill).
//                         A sitemap listing a disallowed, noindexed URL contradicts both, and Search
//                         Console reports it as an error. Do not re-add it without reversing those.
//                         tests/search/search-crawl-controls.test.tsx checks that every URL here is
//                         allowed by robots.txt.
import type { MetadataRoute } from 'next';

const ORIGIN = 'https://kidsfunapp.ca';

/** Public, stable, and genuinely worth a crawler's time. */
const STATIC_PATHS = [
  { path: '/', priority: 1.0, changeFrequency: 'daily' as const },
  { path: '/coverage-status', priority: 0.5, changeFrequency: 'weekly' as const },
  { path: '/privacy', priority: 0.3, changeFrequency: 'yearly' as const },
  { path: '/terms', priority: 0.3, changeFrequency: 'yearly' as const },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return STATIC_PATHS.map(({ path, priority, changeFrequency }) => ({
    url: `${ORIGIN}${path}`,
    lastModified,
    changeFrequency,
    priority,
  }));
}
