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
     *   · CSS loaded same-origin, but it @imports Google Fonts       → style-src + font-src
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
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      'connect-src \'self\' https://*.sentry.io',
    ].join('; ');

    const antiFramingAndSniffing = [
      { key: 'content-security-policy', value: contentSecurityPolicy },
      { key: 'x-frame-options', value: 'DENY' },
      { key: 'x-content-type-options', value: 'nosniff' },
      { key: 'strict-transport-security', value: 'max-age=31536000' },
    ];

    return [
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
