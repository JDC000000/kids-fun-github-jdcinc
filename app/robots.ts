// app/robots.ts — /robots.txt, which 404'd until now (fresh-eyes QA audit, 2026-09-03).
//
// ═══ THE TWO DISALLOWS THAT ARE NOT HOUSEKEEPING ═══
// /u/ and /s/ are PER-SUBSCRIBER TOKENISED URLS and must never be crawled.
//
//   /u/{preferencesToken}  the no-login preferences hub. app/u/[preferencesToken]/page.tsx sets
//                          noindex/nofollow and no-store already, and its own comment explains
//                          why: an indexed copy would put a child's ages and a household postal
//                          code into a search engine, and "there is no undoing that".
//   /s/{token}             the per-click short link in every weekly text. Following one writes an
//                          sms_click_event attributed to a real subscriber, so a crawler walking
//                          these would manufacture engagement that never happened — the analytics
//                          equivalent of the same leak.
//
// The page-level noindex on /u is the stronger guarantee and stays; this is defence in depth for
// the crawlers that read robots.txt but never fetch the page. /s/ has NO page-level equivalent —
// it is a redirect route, so there is no <meta> to attach — which makes this its only protection.
//
// /admin is gated and 404s for un-gated callers, and /api returns JSON. Neither belongs in an
// index and neither should be spent crawl budget on.
import type { MetadataRoute } from 'next';

/** The production origin. Deliberately a literal: a sitemap pointing at the wrong host is worse
 *  than no sitemap, and this file must not inherit a misconfigured env var. */
const ORIGIN = 'https://kidsfunapp.ca';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/admin', '/api', '/u/', '/s/'],
      },
    ],
    sitemap: `${ORIGIN}/sitemap.xml`,
    host: ORIGIN,
  };
}
