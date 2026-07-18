// Sentry — edge runtime initialisation (middleware/edge routes run here).
// Loaded by instrumentation.ts's register() hook when NEXT_RUNTIME === 'edge'.
// NOTE: this initialises the Sentry edge SDK only; it does NOT modify middleware.ts
// (that file is owned by a parallel workstream this round). Middleware errors are
// still captured via the SDK's automatic build-time instrumentation.
import * as Sentry from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_APP_ENV || 'development',
  // Error monitoring only (see sentry.server.config.ts for rationale).
  tracesSampleRate: 0,
  sendDefaultPii: false,
});
