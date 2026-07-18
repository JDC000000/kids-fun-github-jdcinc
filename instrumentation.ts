// Next.js instrumentation entrypoint. withSentryConfig auto-enables
// `experimental.instrumentationHook` on Next < 15, so register() runs on boot
// and initialises the correct Sentry SDK for the active runtime.
import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Captures errors thrown in nested React Server Components (Next.js >= 15 hook;
// a no-op on 14.2 but harmless to export — future-proofs a Next upgrade).
export const onRequestError = Sentry.captureRequestError;
