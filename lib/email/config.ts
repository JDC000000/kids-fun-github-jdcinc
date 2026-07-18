// lib/email/config.ts — environment + link configuration for the weekly digest.
//
// One place that knows every email-related env var, so no other module reaches
// into process.env directly and secrets are never logged. Nothing here EVER
// returns a secret to a caller that would print it — getResendApiKey() is used
// only to build an Authorization header inside lib/email/resend.ts.
//
// Env vars (all added to .env.example):
//   RESEND_API_KEY                    — Resend API key (secret; vaulted as
//                                       credential slug `kids-fun-resend`).
//   EMAIL_FROM                        — verified From address, e.g.
//                                       "KIDS FUN <hello@mail.kidsfun.example>".
//   NEXT_PUBLIC_SITE_URL              — public app base URL for links back in.
//   WEEKLY_EMAIL_UNSUBSCRIBE_SECRET   — HMAC secret for one-click unsubscribe tokens.
//   WEEKLY_EMAIL_CRON_SECRET          — shared secret guarding the bulk trigger route.
//   WEEKLY_EMAIL_ENABLED              — "true" to permit REAL sends; anything else
//                                       forces dry-run (payload built, never dispatched).

/** Default From used when EMAIL_FROM is unset (dev/preview only; real sends require a verified domain). */
const DEFAULT_FROM = 'KIDS FUN <onboarding@resend.dev>';

/** Fallback app URL when NEXT_PUBLIC_SITE_URL is unset (links still render, just point local). */
const DEFAULT_SITE_URL = 'http://localhost:3000';

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : undefined;
}

/** The public site base URL, without a trailing slash. */
export function siteUrl(): string {
  return (env('NEXT_PUBLIC_SITE_URL') ?? DEFAULT_SITE_URL).replace(/\/+$/, '');
}

/** Build an absolute app URL from a path (path may start with or without a leading slash). */
export function appUrl(path = '/'): string {
  const base = siteUrl();
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
}

/** From address for the digest. */
export function fromAddress(): string {
  return env('EMAIL_FROM') ?? DEFAULT_FROM;
}

/** The Resend API key, or null if not configured (dry-run only in that case). */
export function getResendApiKey(): string | null {
  return env('RESEND_API_KEY') ?? null;
}

/** The unsubscribe HMAC secret, or null if unconfigured. */
export function unsubscribeSecret(): string | null {
  return env('WEEKLY_EMAIL_UNSUBSCRIBE_SECRET') ?? null;
}

/** The cron/bulk-trigger shared secret, or null if unconfigured. */
export function cronSecret(): string | null {
  return env('WEEKLY_EMAIL_CRON_SECRET') ?? null;
}

/**
 * Whether REAL sending is permitted. Defaults to FALSE: unless
 * WEEKLY_EMAIL_ENABLED === 'true', the whole pipeline runs in dry-run (build the
 * Resend payload, never dispatch), so a misconfigured or accidental run can never
 * email real parents. Going live is a deliberate, one-line env flip.
 */
export function sendingEnabled(): boolean {
  return env('WEEKLY_EMAIL_ENABLED') === 'true';
}
