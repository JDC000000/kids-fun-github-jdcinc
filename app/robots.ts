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
//
// /preview is the interim mobile fixture/demo shell (app/preview/README.md) — a legitimate,
// intentionally public surface, NOT a secret leak (it resolves the same live search/detail data
// as the canonical /search and /activity/[id] routes, and its own detail page already sets
// <link rel=canonical> AT /activity/[id] so it never competes for that content). Disallowing it
// here is pure crawl-budget/duplicate-content hygiene, the same reasoning as /admin and /api
// above — it changes nothing about who can reach the page, only whether search engines bother to.
//
// ═══ /search IS DISALLOWED FOR COST, NOT PRIVACY (2026-09-24, Jon-approved) ═══
// About 96% of the Aug 27 – Sep 27 Vercel bill was GPTBot walking /search filter permutations.
// Every chip on /search is a real link to another /search?… URL, so a crawler that follows links
// never runs out of pages, and every page is a function invocation plus a search. robots.txt
// allowed it. The app-level rate limiter (Sep 22) is what stopped the bleeding, but it only
// makes each request cheap; this makes compliant crawlers stop asking.
//
// This is one of three layers, each for a crawler the others miss:
//   - this file, for crawlers that read robots.txt;
//   - the noindex,nofollow in app/search/layout.tsx, for crawlers that fetch the page anyway;
//   - rel="nofollow" on every link into a /search permutation (app/_lib/search-link-rel.ts).
//
// `Disallow: /search` is a PREFIX rule, so it covers every /search?… permutation as well as the
// bare page. It would also cover any future route starting with "/search"; none exists today.
//
// ═══ NO `Allow: /` LINE, ON PURPOSE (QA finding F1, 2026-09-25) ═══
// This group used to open with `Allow: /`, and Next always serializes Allow lines BEFORE Disallow
// lines. Under RFC 9309 longest-match (Google, Bing, robots-parser) that was harmless. But a
// FIRST-match parser (e.g. Python's stdlib urllib.robotparser) stops at `Allow: /` and reads
// /search and every private path below as ALLOWED. Allow is the default for any path no rule
// matches, so the line added nothing under either reading, and it is gone.
// tests/search/search-crawl-controls.test.tsx checks the result with a first-match evaluator too.
// Do not add an `allow` here unless it is narrower than every disallow it could shadow.
//
// Accepted trade-off: /search stops being crawled, so it drops out of search-engine results over
// time. Parents still reach it from every page through the nav, the home page and the 404.
//
// ═══ AI CRAWLERS: `Disallow: /`, SITE-WIDE (Jon, 2026-09-24) ═══
// Jon's decision: AI crawlers are blocked from the whole site, and "it's fine that it blocks AI
// assistant answers". They get their OWN group with `Disallow: /`. The token list, the reason for
// each token and the vendor sources are in app/_lib/ai-crawlers.ts.
// Under RFC 9309 a crawler obeys only the most specific group that names it, and groups are never
// merged. So a listed AI crawler ignores the `*` group completely (its `Disallow: /` already covers
// /search), and every crawler NOT listed (Googlebot, Bingbot, Applebot, DuckDuckBot, the
// link-preview fetchers) keeps exactly the `*` group above, including the /search rule.
// The /search rule is still needed: search engines crawl permutations too, and so does any bot
// the list does not name.
import type { MetadataRoute } from 'next';
import { AI_CRAWLER_USER_AGENTS } from './_lib/ai-crawlers';

/** The production origin. Deliberately a literal: a sitemap pointing at the wrong host is worse
 *  than no sitemap, and this file must not inherit a misconfigured env var. */
const ORIGIN = 'https://kidsfunapp.ca';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        disallow: ['/admin', '/api', '/u/', '/s/', '/preview', '/search'],
      },
      {
        userAgent: [...AI_CRAWLER_USER_AGENTS],
        disallow: '/',
      },
    ],
    sitemap: `${ORIGIN}/sitemap.xml`,
    host: ORIGIN,
  };
}
