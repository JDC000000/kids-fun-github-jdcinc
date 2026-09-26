import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Staging + production are distinguished by env, not code (TSD §3A.3 three-env model).
  env: {
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV ?? 'development',
  },

  /**
   * Response headers for the SMS preferences / hub page (PRD §2.4).
   *
   * ═══ WHY THIS IS HERE AND NOT IN THE PAGE ═══
   * `/u/[preferencesToken]` is a Server Component page, not a Route Handler, so it cannot set
   * response headers the way app/s/[shortId]/route.ts does with `response.headers.set(...)`. Its
   * `metadata.robots` export covers `noindex` — a meta tag — but a meta tag cannot express
   * `Cache-Control` or `Referrer-Policy`, which are transport concerns. This is the declarative
   * mechanism Next.js provides for exactly that, and it matches dynamic segments (`:param`), so it
   * fits this route without touching middleware.ts, which exists for an unrelated analytics
   * concern and is owned elsewhere.
   *
   * ═══ WHY THE PAGE NEEDS THEM ═══
   * THE URL ITSELF IS THE CREDENTIAL. `preferencesToken` is the sole bearer credential for
   * viewing a subscriber's data, editing it, and unsubscribing — there is no login behind it.
   *
   * `Referrer-Policy: no-referrer` is the one that closes a live leak. The page links out to each
   * of last week's picks, and under default browser behaviour a click sends the full referring
   * URL — TOKEN INCLUDED — to that third party. A rec centre's analytics would receive a working
   * credential for somebody's subscription. app/s/[shortId]/route.ts already guards its own
   * redirect this way; this page's header comment CLAIMED to and did not.
   *
   * `Cache-Control: no-store` keeps the rendered HTML — a child's ages and a household postal
   * code — out of browser and intermediary caches, so the back button on a shared or family
   * computer cannot resurrect them.
   *
   * Verified against a real `next start` response, not assumed — see tests/sms/preferences.test.ts
   * for the assertion on this configuration and the round-17 notes for the live check.
   */
  /**
   * /sms/signup → /sms/start, permanently (Jon, 2026-09-01).
   *
   * /sms/start is the primary landing page now. This keeps every QR code, bookmark and shared
   * link that already points at /sms/signup landing somewhere live instead of at a page being
   * retired under them.
   *
   * PERMANENT = 308, which preserves the request METHOD as well as the body — unlike 301/302,
   * which browsers historically downgrade to GET. Nothing POSTs to this path today, but a
   * permanent redirect outlives the assumption that nothing ever will.
   *
   * QUERY STRINGS RIDE ALONG AUTOMATICALLY. Next carries them for a redirect with no `:path*`
   * wildcard, so ?utm_source=... survives the hop and attribution is not silently dropped.
   *
   * ⚠ BUILD-TIME, NOT RUNTIME. Like headers() below, this is baked into
   * .next/routes-manifest.json when the app is built — a restart does not pick it up. Verifying
   * this in a running deployment means a REDEPLOY, not a bounce.
   *
   * WHY THE CONFIG AND NOT redirect() INSIDE THE PAGE: this fires before the route renders, so a
   * retired page costs nothing to serve. The one behavioural nuance, stated rather than hidden:
   * app/sms/signup/page.tsx gated itself with `if (!smsSignupEnabled()) notFound()`, and that gate
   * is now unreachable — a request arrives at /sms/start instead, which applies THE SAME gate
   * (app/sms/start/page.tsx:36) and 404s identically. The end state matches; only the hop is new.
   *
   * SELF-CONTROLLED REFERENCES DO NOT RELY ON THIS. signupUrl() and the preferences fallback link
   * point straight at /sms/start. This redirect is for links we do not control and cannot edit.
   */
  async redirects() {
    return [{ source: '/sms/signup', destination: '/sms/start', permanent: true }];
  },

  async headers() {
    /*
     * ── SHARED TRANSPORT HARDENING, APPLIED TO BOTH SMS-FACING PAGES ─────────────────────────
     * Added 2026-08-28 for the preferences hub; extended to the signup form the same day.
     * Written once because two copies of a security header list is how one of them silently
     * stops matching the other.
     *
     * `frame-ancestors 'none'` and X-Frame-Options say the same thing to different generations
     * of browser: these pages may not be framed. On the HUB that matters because a clickjacked
     * preferences page is a clickjacked UNSUBSCRIBE and DELETE button, both one click with no
     * confirmation behind no login. On the SIGNUP FORM it matters for a different and arguably
     * stronger reason: that page is where EXPRESS CONSENT IS CAPTURED, and consent collected
     * inside somebody else's frame — under their heading, their branding, their surrounding
     * claims — is not obviously the consent CASL requires a record of. `consent_text_version`
     * pins the wording a subscriber agreed to; it cannot pin the page around it. Refusing to be
     * framed is what keeps that record meaning what it says.
     *
     * ── THE FULL POLICY (2026-08-28). MEASURED AGAINST A REAL PRODUCTION BUILD. ─────────────
     * Every directive below was derived by building the app, serving it with `next start`, and
     * reading what the two pages ACTUALLY load — not from Next's documentation, and not from
     * what a CSP "should" say. Verified in Chromium afterwards with the policy live. `next dev`
     * was deliberately NOT used as the basis: dev needs 'unsafe-eval' for HMR, so a policy that
     * passes there says nothing about production.
     *
     * What the measurement found on /sms/signup and /u/{token}:
     *   · 14 external scripts, ALL same-origin /_next/static/…       → 'self'
     *   · 5-6 INLINE <script> blocks — Next's hydration payload      → see 'unsafe-inline' below
     *   · ZERO inline <style> blocks and ZERO style="" attributes    → style-src needs NO
     *     'unsafe-inline', which is the directive that usually gets weakened by reflex
     *   · CSS loaded same-origin; its Google Fonts @import never worked and is now gone
     *     (next/font, 2026-08-28) → style-src and font-src are 'self' only
     *   · no <img>, no <svg>, no url() beyond the font import
     *
     * ⚠ `script-src` CARRIES 'unsafe-inline', AND THAT IS A REAL WEAKNESS — SAID PLAINLY.
     * Next 14's App Router inlines its hydration payload as `self.__next_f.push([...])`, and the
     * content differs per request, so hashes are impossible. The strong alternative is a
     * per-request nonce, which on this version has to be minted in middleware.ts — a file that
     * exists for an unrelated analytics concern and is OWNED BY ANOTHER WORKSTREAM. Reaching
     * into it to add nonce plumbing is a bigger and more coupled change than this pass was
     * scoped for.
     *   So be honest about what this buys: it BLOCKS an injected <script src="https://evil…">
     *   and any eval'd code, and it does NOT block injected inline script. That is a partial
     *   win, not XSS protection. Anyone who reads "CSP" here and assumes the latter is being
     *   misled, which is why it is written down.
     *
     * `connect-src` allows Sentry because instrumentation-client.ts initialises the browser SDK
     * on every page. ⚠ The production DSN's host could NOT be verified from here — .env.example
     * holds names only, correctly — so this uses Sentry's own domain wildcard. If the real DSN
     * points somewhere else, error reporting from these two routes stops SILENTLY. Flagged for
     * the Operator to confirm against the live DSN.
     *
     * No 'unsafe-eval' anywhere: the production bundle does not need it, which the browser check
     * confirms rather than assumes.
     *
     * HSTS is a no-op over plain HTTP (the local harness) and takes effect in production, which
     * is the only place it matters. No `preload`, and no `includeSubDomains`: both are
     * commitments about domains this config does not own, and preload in particular is
     * effectively irreversible. Worth having on the signup form specifically because that page
     * is frequently the FIRST one a subscriber ever opens — the earliest chance to set it.
     */
    const contentSecurityPolicy = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self' 'unsafe-inline'",
      // TIGHTENED once Manrope moved to next/font (self-hosted, app/layout.tsx). These two
      // directives previously allowed fonts.googleapis.com and fonts.gstatic.com for an @import
      // that — as it turned out — had never once loaded. Nothing external is fetched now, so the
      // allowance was removed rather than left standing for a request that no longer happens.
      //   ⚠ A consequence worth knowing: adding a Google Fonts @import back would now be BLOCKED
      //   by this policy rather than silently ignored. That is the better failure, and the right
      //   way to add a face is next/font, which needs no CSP change at all because it self-hosts.
      "style-src 'self'",
      "font-src 'self'",
      "img-src 'self' data:",
      'connect-src \'self\' https://*.sentry.io',
    ].join('; ');

    const antiFramingAndSniffing = [
      { key: 'content-security-policy', value: contentSecurityPolicy },
      { key: 'x-frame-options', value: 'DENY' },
      { key: 'x-content-type-options', value: 'nosniff' },
      { key: 'strict-transport-security', value: 'max-age=31536000' },
    ];

    /*
     * The admin console and its APIs (2026-09-24). /admin/sms-subscribers renders subscriber phone
     * numbers, postal codes and children's ages; the admin sign-in round-trip carries an OAuth
     * `code` in its URL; and until 2026-09-24 the console accepted a shared secret as `?token=`.
     *   · no-referrer — an outbound click (the corrections queue links to each listing's source
     *     site) must not hand the admin URL, query string included, to a third party.
     *   · no-store — a page of personal data must not be kept by a browser or intermediary cache,
     *     so the back button on a shared machine cannot resurrect it.
     *   · noindex — the console is unadvertised; this is the header form of the pages' own
     *     `robots` metadata, and it also covers the API routes, which have no metadata.
     * No CSP / frame headers here on purpose: the console renders its own inline <style> blocks,
     * which the public pages' `style-src 'self'` would break. Pinned by tests/admin/admin_headers.test.ts.
     */
    const adminPrivacy = [
      { key: 'referrer-policy', value: 'no-referrer' },
      { key: 'cache-control', value: 'no-store, max-age=0' },
      { key: 'x-robots-tag', value: 'noindex, nofollow' },
    ];

    return [
      { source: '/admin/:path*', headers: adminPrivacy },
      { source: '/api/admin/:path*', headers: adminPrivacy },
      {
        source: '/u/:preferencesToken',
        headers: [
          { key: 'referrer-policy', value: 'no-referrer' },
          { key: 'cache-control', value: 'no-store, max-age=0' },
          ...antiFramingAndSniffing,
        ],
      },
      {
        /*
         * The minimal signup landing page (/sms/start). Collects the SAME data as /sms/signup —
         * a phone number, a postal code and a child's age — so it gets the SAME protection. A
         * second form behind weaker headers than the first would quietly undo the reasoning that
         * put them on the first, and it is the consent-capture argument that matters most here:
         * a consent form that can be framed is a consent record about a page we did not control.
         */
        source: '/sms/start',
        headers: antiFramingAndSniffing,
      },
      {
        /*
         * The public signup form. It renders NO stored personal data and its URL carries no
         * credential, which is why it does not take the hub's other two headers:
         *   · no `no-referrer` — there is nothing secret in this URL to leak to a link target.
         *   · no `no-store` — this is a public page with nothing personal in its HTML, and
         *     making it uncacheable would slow the one page the product most wants to load fast
         *     while buying no privacy. The data a parent TYPES here is protected by being sent
         *     in a POST body over TLS, not by a cache header.
         * What it does need is to be un-frameable, for the consent reason above.
         */
        source: '/sms/signup',
        headers: antiFramingAndSniffing,
      },
    ];
  },
};

// Wrap with Sentry. On Next < 15 this also auto-enables
// `experimental.instrumentationHook`, so instrumentation.ts's register() runs.
export default withSentryConfig(nextConfig, {
  // Only needed for source-map upload (CI). Env-gated: a build without these
  // simply skips the upload and still succeeds (verified locally).
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Quiet plugin logs outside CI.
  silent: !process.env.CI,

  // Upload a wider set of client files for better source-mapped stack traces.
  widenClientFileUpload: true,

  // Bundle-size trims. We run Sentry in error-monitoring-only mode
  // (tracesSampleRate: 0), so tree-shaking the debug logger AND the tracing /
  // performance code keeps the client bundle lean. NOTE: if you later enable
  // performance monitoring (raise tracesSampleRate), remove `removeTracing`.
  webpack: {
    treeshake: {
      removeDebugLogging: true,
      removeTracing: true,
    },
  },

  // The onRouterTransitionStart hook is exported from instrumentation-client.ts
  // but only wired by Next.js >= 15.3; suppress the harmless build-time notice.
  suppressOnRouterTransitionStartWarning: true,

  // Intentionally NOT set this round: `tunnelRoute` (adds an API route and can
  // interact with routing/middleware — middleware.ts is owned by a parallel
  // workstream) and `automaticVercelMonitors`.
});
