// Sentry — browser/client initialisation.
// The current SDK convention (v10) replaces the deprecated `sentry.client.config.ts`
// with this file; withSentryConfig injects it into the client bundle at build time.
// The DSN must be a NEXT_PUBLIC_* var so Next.js inlines it into the client bundle.
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  // No-op unless a DSN is present for this environment.
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_APP_ENV || 'development',
  // Error monitoring only (no performance tracing / no Session Replay) — keeps
  // the client bundle lean and scope tight. See sentry.server.config.ts.
  tracesSampleRate: 0,
  sendDefaultPii: false,
});

// App Router navigation-instrumentation hook. Wired by Next.js >= 15.3; a no-op
// on 14.2 but harmless to export — future-proofs a Next upgrade.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
