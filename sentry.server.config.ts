// Sentry — server (Node.js runtime) initialisation.
// Loaded by instrumentation.ts's register() hook when NEXT_RUNTIME === 'nodejs'.
// DSN + org/project are injected per-environment via Vercel env (never committed).
import * as Sentry from '@sentry/nextjs';

import { scrubEvent } from './sentry.scrub';

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  // No-op (never phones home) unless a DSN is provided for this environment —
  // keeps local / CI / test runs silent.
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_APP_ENV || 'development',
  // Scope = error monitoring. Performance tracing is intentionally off to keep
  // the integration focused and avoid consuming the transactions quota on a new
  // Sentry account; raise this (e.g. 0.1) per-environment to enable it later.
  tracesSampleRate: 0,
  // Privacy: this is a kids-activity product — never attach request PII by default.
  sendDefaultPii: false,
  // Explicit PII deny-list (defense-in-depth on top of sendDefaultPii:false):
  // redact email / IP / phone-shaped values and strip identity, cookies and
  // auth headers before any event leaves the server. See sentry.scrub.ts.
  beforeSend: (event) => scrubEvent(event),
  // Applies the same deny-list to transactions if tracing is ever enabled.
  beforeSendTransaction: (event) => scrubEvent(event),
});
