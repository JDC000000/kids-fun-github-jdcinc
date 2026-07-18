import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Staging + production are distinguished by env, not code (TSD §3A.3 three-env model).
  env: {
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV ?? 'development',
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
