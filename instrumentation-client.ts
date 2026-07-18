// Sentry — browser/client initialisation.
// The current SDK convention (v10) replaces the deprecated `sentry.client.config.ts`
// with this file; withSentryConfig injects it into the client bundle at build time.
// The DSN must be a NEXT_PUBLIC_* var so Next.js inlines it into the client bundle.
import * as Sentry from '@sentry/nextjs';

import { scrubEvent } from './sentry.scrub';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  // No-op unless a DSN is present for this environment.
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_APP_ENV || 'development',
  // Issue ownership (G-T37-3): stamp every event with the owning team + runtime
  // so each Sentry issue is an attributable, owned internal-bug record. The
  // project Ownership Rule (tags.owner_team:kids-fun #jdc000000) auto-assigns
  // these to the owning team. Additive, PII-free.
  initialScope: {
    tags: {
      owner_team: 'kids-fun',
      app_runtime: 'browser',
    },
  },
  // Error monitoring only (no performance tracing / no Session Replay) — keeps
  // the client bundle lean and scope tight. See sentry.server.config.ts.
  tracesSampleRate: 0,
  sendDefaultPii: false,
  // Explicit PII deny-list (defense-in-depth on top of sendDefaultPii:false):
  // redact email / IP / phone-shaped values and strip identity + auth data
  // before any event leaves the browser. See sentry.scrub.ts.
  beforeSend: (event) => scrubEvent(event),
  // Applies the same deny-list to transactions if tracing is ever enabled.
  beforeSendTransaction: (event) => scrubEvent(event),
});

// App Router navigation-instrumentation hook. Wired by Next.js >= 15.3; a no-op
// on 14.2 but harmless to export — future-proofs a Next upgrade.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
