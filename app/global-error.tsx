'use client';

// Root-level error boundary. When an error escapes the root layout, Next.js
// renders this in place of the entire app, so it must supply its own <html>/<body>.
// The error is reported to Sentry before a friendly fallback is shown.
// (Global errors surface in production builds; in dev Next shows its overlay instead.)
import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          background: '#f7f7fb',
          color: '#1a1a2e',
        }}
      >
        <main style={{ textAlign: 'center', padding: '2rem', maxWidth: '32rem' }}>
          <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>
            Something went wrong
          </h1>
          <p style={{ marginBottom: '1.5rem', color: '#55556a' }}>
            Sorry — an unexpected error occurred. Our team has been notified.
            Please try again.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              padding: '0.625rem 1.25rem',
              fontSize: '1rem',
              borderRadius: '0.5rem',
              border: 'none',
              background: '#4f46e5',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
