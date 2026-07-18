// Sentry — edge runtime initialisation (middleware/edge routes run here).
// Loaded by instrumentation.ts's register() hook when NEXT_RUNTIME === 'edge'.
// NOTE: this initialises the Sentry edge SDK only; it does NOT modify middleware.ts
// (that file is owned by a parallel workstream this round). Middleware errors are
// still captured via the SDK's automatic build-time instrumentation.
import * as Sentry from '@sentry/nextjs';

import { scrubEvent } from './sentry.scrub';

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_APP_ENV || 'development',
  // Issue ownership (G-T37-3): stamp every event with the owning team + runtime
  // so each Sentry issue is an attributable, owned internal-bug record. The
  // project Ownership Rule (tags.owner_team:kids-fun #jdc000000) auto-assigns
  // these to the owning team. Additive, PII-free, Edge-safe (plain strings).
  initialScope: {
    tags: {
      owner_team: 'kids-fun',
      app_runtime: 'edge',
    },
  },
  // Error monitoring only (see sentry.server.config.ts for rationale).
  tracesSampleRate: 0,
  sendDefaultPii: false,
  // Explicit PII deny-list (defense-in-depth on top of sendDefaultPii:false):
  // redact email / IP / phone-shaped values and strip identity + auth data
  // before any event leaves the edge runtime. See sentry.scrub.ts. Pure
  // string/object work only — no Node built-ins, so it is Edge-safe.
  beforeSend: (event) => scrubEvent(event),
  // Applies the same deny-list to transactions if tracing is ever enabled.
  beforeSendTransaction: (event) => scrubEvent(event),
});
