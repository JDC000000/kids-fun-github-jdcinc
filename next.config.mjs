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
    return [
      {
        source: '/u/:preferencesToken',
        headers: [
          { key: 'referrer-policy', value: 'no-referrer' },
          { key: 'cache-control', value: 'no-store, max-age=0' },
        ],
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
